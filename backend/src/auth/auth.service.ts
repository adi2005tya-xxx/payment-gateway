import { DomainError } from '../common/errors';
import { Db, Queryable } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { createHash, randomBytes } from 'crypto';
import { hashPassword, validatePasswordStrength, verifyPassword } from './password';
import { SecretBox } from './secretbox';

export interface SecurityOptions {
  /** 32-byte key for MFA secret encryption (inject from a secrets manager). */
  mfaKey: Buffer;
  mfaKeyPrevious?: Buffer[];
  issuer: string;
  stepUpWindowSeconds: number;
  recoveryDelayHours: number;
  /** Roles that MUST use MFA. Anyone who has enrolled is also held to MFA regardless of role. */
  requiredRoles: string[];
  sessionTtlMinutes: number;
  maxMfaAttempts: number;
  mfaLockMinutes: number;
  maxLoginAttempts: number;
  loginLockMinutes: number;
  /** Injectable clock (tests). */
  clock?: () => Date;
}

export interface SessionInfo {
  id: string;
  userId: string;
  email: string;
  role: string;
  merchantId: string | null;
  mfaVerifiedAt: Date | null;
  stepupAt: Date | null;
  enrolled: boolean;
  expiresAt: Date;
}

export type MfaState = 'NOT_REQUIRED' | 'ENROL_REQUIRED' | 'CHALLENGE_REQUIRED';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidCredentials = () => new DomainError('INVALID_CREDENTIALS', 'Invalid email or password', 401);

let dummyHash: Promise<string> | undefined;

export class AuthService {
  private readonly box: SecretBox;

  constructor(private readonly db: Db, private readonly audit: AuditService, readonly opts: SecurityOptions) {
    this.box = new SecretBox(opts.mfaKey, opts.mfaKeyPrevious);
  }

  now(): Date {
    return (this.opts.clock ?? (() => new Date()))();
  }

  isMfaRequired(role: string, enrolled: boolean): boolean {
    return enrolled || this.opts.requiredRoles.includes(role);
  }

  stepUpFresh(session: Pick<SessionInfo, 'mfaVerifiedAt' | 'stepupAt'>): boolean {
    if (!session.mfaVerifiedAt || !session.stepupAt) return false;
    return this.now().getTime() - session.stepupAt.getTime() <= this.opts.stepUpWindowSeconds * 1000;
  }

  /**
   * Verifies email+password with lockout. Every failure path returns the same error, runs a password hash
   * (to keep timing similar) and is audited. Used by login and by the recovery-request endpoint.
   */
  async authenticatePassword(email: string, password: string) {
    const now = this.now();
    const [u] = await this.db.query<any>('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!u || u.status !== 'ACTIVE') {
      dummyHash ??= hashPassword('not-a-real-password');
      await verifyPassword(password, await dummyHash);
      throw invalidCredentials();
    }
    if (u.locked_until && new Date(u.locked_until) > now) {
      await this.db.transaction((tx) => this.audit.record(tx, { id: u.id, role: u.role }, 'auth.login.rejected_locked', 'user', u.id));
      throw invalidCredentials(); // do not reveal the lock to someone guessing passwords
    }
    if (!(await verifyPassword(password, u.password_hash))) {
      await this.db.transaction(async (tx) => {
        const [r] = await tx.query<{ failed_logins: number }>('UPDATE users SET failed_logins = failed_logins + 1 WHERE id=$1 RETURNING failed_logins', [u.id]);
        await this.audit.record(tx, { id: u.id, role: u.role }, 'auth.login.failed', 'user', u.id, { consecutiveFailures: r.failed_logins });
        if (r.failed_logins >= this.opts.maxLoginAttempts) {
          await tx.query('UPDATE users SET failed_logins=0, locked_until=$2 WHERE id=$1', [u.id, new Date(now.getTime() + this.opts.loginLockMinutes * 60_000)]);
          await this.audit.record(tx, { id: u.id, role: u.role }, 'auth.account.locked', 'user', u.id, { minutes: this.opts.loginLockMinutes });
        }
      });
      throw invalidCredentials();
    }
    if (u.failed_logins > 0) await this.db.query('UPDATE users SET failed_logins=0 WHERE id=$1', [u.id]);
    return u;
  }

  /** Password step of login. Always creates a brand-new, MFA-unverified session (no session fixation). */
  async login(email: string, password: string) {
    const u = await this.authenticatePassword(email, password);
    await this.executeApprovedRecovery(u.id);
    const [m] = await this.db.query<any>('SELECT secret_enc FROM user_mfa WHERE user_id=$1', [u.id]);
    const enrolled = !!m?.secret_enc;
    const mfa: MfaState = !this.isMfaRequired(u.role, enrolled) ? 'NOT_REQUIRED' : enrolled ? 'CHALLENGE_REQUIRED' : 'ENROL_REQUIRED';
    const session = await this.db.transaction(async (tx) => {
      const s = await this.createSession(tx, u.id, false);
      await this.audit.record(tx, { id: u.id, role: u.role }, 'auth.login.password_ok', 'user', u.id, { mfa });
      return s;
    });
    return { user: u, session, mfa };
  }

  async createSession(tx: Queryable, userId: string, mfaVerified: boolean) {
    const now = this.now();
    const [s] = await tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO auth_sessions(user_id, expires_at, mfa_verified_at, stepup_at) VALUES ($1,$2,$3,$3) RETURNING id, expires_at`,
      [userId, new Date(now.getTime() + this.opts.sessionTtlMinutes * 60_000), mfaVerified ? now : null],
    );
    return { id: s.id, expiresAt: new Date(s.expires_at) };
  }

  /** Resolves a session id to its state, or null if unknown/expired/revoked/user disabled. */
  async resolve(sessionId: unknown): Promise<SessionInfo | null> {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
    const [r] = await this.db.query<any>(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.mfa_verified_at, s.stepup_at, u.email, u.role, u.merchant_id, u.status,
              (m.secret_enc IS NOT NULL) AS enrolled
         FROM auth_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_mfa m ON m.user_id = u.id WHERE s.id=$1`,
      [sessionId],
    );
    if (!r || r.revoked_at || r.status !== 'ACTIVE' || new Date(r.expires_at) <= this.now()) return null;
    return {
      id: r.id, userId: r.user_id, email: r.email, role: r.role, merchantId: r.merchant_id,
      mfaVerifiedAt: r.mfa_verified_at ? new Date(r.mfa_verified_at) : null,
      stepupAt: r.stepup_at ? new Date(r.stepup_at) : null,
      enrolled: !!r.enrolled, expiresAt: new Date(r.expires_at),
    };
  }

  async revokeSession(tx: Queryable, sessionId: string, reason: string) {
    await tx.query(`UPDATE auth_sessions SET revoked_at=$2, revoked_reason=$3 WHERE id=$1 AND revoked_at IS NULL`, [sessionId, this.now(), reason]);
  }

  async revokeAllForUser(tx: Queryable, userId: string, reason: string, exceptSessionId?: string) {
    await tx.query(
      `UPDATE auth_sessions SET revoked_at=$2, revoked_reason=$3 WHERE user_id=$1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4)`,
      [userId, this.now(), reason, exceptSessionId ?? null],
    );
  }

  async logout(session: SessionInfo) {
    await this.db.transaction(async (tx) => {
      await this.revokeSession(tx, session.id, 'logout');
      await this.audit.record(tx, { id: session.userId, role: session.role }, 'auth.logout', 'user', session.userId);
    });
  }

  // ------------------------------------------------------------------ password reset
  /**
   * Always answers the same way (no account enumeration). For an active account it stores only a HASH of a 256-bit single-use token
   * (30 min) and queues an email; the raw token is held encrypted in the queue row until the email is sent, then scrubbed.
   * A reset changes the password only: it never disables MFA, and it revokes every session.
   */
  async requestPasswordReset(email: string) {
    const now = this.now();
    const [u] = await this.db.query<any>(`SELECT id, email, role FROM users WHERE email=$1 AND status='ACTIVE'`, [email.toLowerCase()]);
    if (u) {
      const [recent] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id=$1 AND created_at > $2::timestamptz - interval '1 hour'`, [u.id, now.toISOString()]);
      if (recent.n < 3) {
        const token = randomBytes(32).toString('base64url');
        await this.db.transaction(async (tx) => {
          await tx.query(`UPDATE password_resets SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL`, [u.id, now]);
          await tx.query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [u.id, createHash('sha256').update(token).digest('hex'), new Date(now.getTime() + 30 * 60_000)]);
          await tx.query(`INSERT INTO notification_jobs(kind, payload) VALUES ('PASSWORD_RESET', $1)`, [JSON.stringify({ to: u.email, tokenEnc: this.box.encrypt(token, 'password-reset') })]);
          await this.audit.record(tx, { id: u.id, role: u.role }, 'auth.password_reset.requested', 'user', u.id);
        });
      }
    }
    return { received: true };
  }

  async confirmPasswordReset(token: string, newPassword: string) {
    validatePasswordStrength(newPassword);
    const now = this.now();
    const hash = createHash('sha256').update(token).digest('hex');
    const passwordHash = await hashPassword(newPassword);
    const ok = await this.db.transaction(async (tx) => {
      const [r] = await tx.query<any>(`SELECT pr.id, pr.user_id, u.role FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > $2 AND u.status='ACTIVE' FOR UPDATE OF pr`, [hash, now]);
      if (!r) return false;
      await tx.query(`UPDATE password_resets SET used_at=$2 WHERE id=$1`, [r.id, now]);
      await tx.query(`UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1`, [r.user_id, passwordHash]);
      await this.revokeAllForUser(tx, r.user_id, 'password_reset');
      await this.audit.record(tx, { id: r.user_id, role: r.role }, 'auth.password_reset.completed', 'user', r.user_id);
      return true;
    });
    if (!ok) throw new DomainError('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired', 400);
    return { ok: true };
  }

  /**
   * Executes an APPROVED recovery request once its delay has elapsed, at the owner's next successful
   * password login: MFA material is deleted, every session revoked, and the user must re-enrol.
   */
  private async executeApprovedRecovery(userId: string) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const [r] = await tx.query<any>(
        `SELECT * FROM mfa_recovery_requests WHERE user_id=$1 AND status='APPROVED' AND execute_after <= $2 AND expires_at > $2 FOR UPDATE`,
        [userId, now],
      );
      if (!r) return;
      await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
      await tx.query(
        `UPDATE user_mfa SET secret_enc=NULL, pending_secret_enc=NULL, enrolled_at=NULL, last_used_step=0, failed_attempts=0, locked_until=NULL, updated_at=$2 WHERE user_id=$1`,
        [userId, now],
      );
      await this.revokeAllForUser(tx, userId, 'mfa_recovery_completed');
      await tx.query(`UPDATE mfa_recovery_requests SET status='COMPLETED', completed_at=$2 WHERE id=$1`, [r.id, now]);
      await this.audit.record(tx, { id: userId, role: 'USER' }, 'mfa.recovery.completed', 'user', userId, { requestId: r.id, approvedBy: r.approved_by });
      await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('MFA_RECOVERY_COMPLETED', $1)`, [JSON.stringify({ userId, requestId: r.id })]);
    });
  }
}
