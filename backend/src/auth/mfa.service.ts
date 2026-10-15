import * as QRCode from 'qrcode';
import { DomainError } from '../common/errors';
import { Db, Queryable } from '../db/db';
import { Actor, AuditService } from '../audit/audit.service';
import { AuthService, SessionInfo } from './auth.service';
import { generateRecoveryCode, SecretBox } from './secretbox';
import { generateTotpSecret, matchTotp, otpauthUri } from './totp';

export interface FactorInput {
  code?: string;
  recoveryCode?: string;
}

type FactorResult =
  | { ok: true; method: 'totp' | 'recovery'; step?: number; remainingCodes?: number }
  | { ok: false; reason: 'invalid' | 'replay' | 'locked' | 'not_enrolled'; lockedNow?: boolean };

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_REQUEST_TTL_HOURS = 72;

const actorOf = (s: Pick<SessionInfo, 'userId' | 'role'>): Actor => ({ id: s.userId, role: s.role });

/**
 * TOTP multi-factor authentication. Rules enforced here (and covered by tests):
 *  - a code is accepted at most once (time-step replay guard, row-locked so concurrent attempts serialise)
 *  - consecutive failures lock the factor; recovery codes are single-use and count toward the same limit
 *  - audit entries record method/outcome/reason only — never secrets, OTPs or recovery codes
 */
export class MfaService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly box: SecretBox,
  ) {}

  private get opts() {
    return this.auth.opts;
  }

  async status(session: SessionInfo) {
    const [m] = await this.db.query<any>('SELECT enrolled_at, locked_until FROM user_mfa WHERE user_id=$1 AND secret_enc IS NOT NULL', [session.userId]);
    const [c] = await this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [session.userId]);
    return {
      required: this.auth.isMfaRequired(session.role, !!m),
      enrolled: !!m,
      enrolledAt: m?.enrolled_at ?? null,
      sessionVerified: !!session.mfaVerifiedAt,
      stepUpFresh: this.auth.stepUpFresh(session),
      recoveryCodesRemaining: Number(c.n),
    };
  }

  // ------------------------------------------------------------------ enrolment
  async startEnrol(session: SessionInfo) {
    if (session.enrolled && !this.auth.stepUpFresh(session)) {
      throw new DomainError('STEP_UP_REQUIRED', 'Re-verify your authenticator to replace it', 403, { stepUp: true });
    }
    const secret = generateTotpSecret();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO user_mfa(user_id, pending_secret_enc) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET pending_secret_enc = EXCLUDED.pending_secret_enc, updated_at = $3`,
        [session.userId, this.box.encrypt(secret, session.userId), this.auth.now()],
      );
      await this.audit.record(tx, actorOf(session), 'mfa.enrol.started', 'user', session.userId, { replacing: session.enrolled });
    });
    const uri = otpauthUri(this.opts.issuer, session.email, secret);
    // The secret leaves the server only here, over TLS, to this authenticated session.
    return { secret, otpauthUri: uri, qrImage: await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2 }) };
  }

  /** Confirms the pending secret with a valid code, activates it, issues recovery codes and rotates the session. */
  async confirmEnrol(session: SessionInfo, code: string) {
    const now = this.auth.now();
    const out = await this.db.transaction(async (tx) => {
      const [m] = await tx.query<any>('SELECT * FROM user_mfa WHERE user_id=$1 FOR UPDATE', [session.userId]);
      if (!m?.pending_secret_enc) return { kind: 'no_pending' as const };
      if (m.locked_until && new Date(m.locked_until) > now) return { kind: 'locked' as const };
      const secret = this.box.decrypt(m.pending_secret_enc, session.userId);
      const step = matchTotp(secret, normaliseCode(code), now.getTime());
      if (step === null) {
        const lockedNow = await this.registerFailure(tx, session, m, 'enrol_confirm', 'invalid', now);
        return { kind: lockedNow ? ('locked' as const) : ('invalid' as const) };
      }
      const replacing = !!m.secret_enc;
      await tx.query(
        `UPDATE user_mfa SET secret_enc=pending_secret_enc, pending_secret_enc=NULL, enrolled_at=$2, last_used_step=$3,
                failed_attempts=0, locked_until=NULL, updated_at=$2 WHERE user_id=$1`,
        [session.userId, now, step],
      );
      const codes = await this.replaceRecoveryCodes(tx, session.userId);
      // A new/replaced authenticator invalidates every other session of this user, including this one (rotated below).
      await this.auth.revokeAllForUser(tx, session.userId, replacing ? 'mfa_device_replaced' : 'mfa_enrolled');
      const fresh = await this.auth.createSession(tx, session.userId, true);
      await this.audit.record(tx, actorOf(session), replacing ? 'mfa.device_replaced' : 'mfa.enrolled', 'user', session.userId);
      await this.audit.record(tx, actorOf(session), 'mfa.recovery_codes.generated', 'user', session.userId, { count: codes.length });
      return { kind: 'ok' as const, session: fresh, codes };
    });
    if (out.kind !== 'ok') {
      if (out.kind === 'no_pending') throw new DomainError('NO_PENDING_ENROLMENT', 'Start enrolment first', 409);
      throw out.kind === 'locked' ? lockedError() : invalidCode();
    }
    return { session: out.session, recoveryCodes: out.codes };
  }

  // ------------------------------------------------------------------ challenge / step-up
  /** Second step of login. On success the unverified session is revoked and a NEW verified one is issued. */
  async challenge(session: SessionInfo, input: FactorInput) {
    if (session.mfaVerifiedAt) throw new DomainError('ALREADY_VERIFIED', 'Session already verified', 409);
    const now = this.auth.now();
    const out = await this.db.transaction(async (tx) => {
      const r = await this.verifyFactor(tx, session, input, 'challenge', now);
      if (!r.ok) return { r };
      await this.auth.revokeSession(tx, session.id, 'rotated_after_mfa');
      const fresh = await this.auth.createSession(tx, session.userId, true);
      await this.cancelOpenRecovery(tx, session, 'owner_authenticated');
      return { r, session: fresh };
    });
    if (!out.r.ok) throw failureError(out.r);
    return { session: out.session!, method: out.r.method, remainingCodes: out.r.remainingCodes };
  }

  /** Re-verifies a factor on an already-verified session, opening the step-up window for high-risk operations. */
  async stepUp(session: SessionInfo, input: FactorInput) {
    if (!session.mfaVerifiedAt) throw new DomainError('MFA_REQUIRED', 'Complete MFA first', 403);
    const now = this.auth.now();
    const r = await this.db.transaction(async (tx) => {
      const res = await this.verifyFactor(tx, session, input, 'step_up', now);
      if (res.ok) await tx.query('UPDATE auth_sessions SET stepup_at=$2 WHERE id=$1', [session.id, now]);
      return res;
    });
    if (!r.ok) throw failureError(r);
    return { steppedUpUntil: new Date(now.getTime() + this.opts.stepUpWindowSeconds * 1000), method: r.method };
  }

  async regenerateRecoveryCodes(session: SessionInfo) {
    if (!this.auth.stepUpFresh(session)) throw new DomainError('STEP_UP_REQUIRED', 'Recent MFA verification required', 403, { stepUp: true });
    return this.db.transaction(async (tx) => {
      const codes = await this.replaceRecoveryCodes(tx, session.userId);
      await this.audit.record(tx, actorOf(session), 'mfa.recovery_codes.regenerated', 'user', session.userId, { count: codes.length });
      return codes;
    });
  }

  // ------------------------------------------------------------------ controlled recovery
  /**
   * Step 1 (the locked-out owner): prove the password, ask for recovery. Nothing changes until another
   * administrator approves AND the delay elapses AND the owner next signs in with their password.
   */
  async requestRecovery(email: string, password: string) {
    const u = await this.auth.authenticatePassword(email, password);
    const now = this.auth.now();
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE mfa_recovery_requests SET status='EXPIRED' WHERE user_id=$1 AND status IN ('REQUESTED','APPROVED') AND expires_at <= $2`, [u.id, now]);
      const [m] = await tx.query<any>('SELECT secret_enc FROM user_mfa WHERE user_id=$1', [u.id]);
      if (!m?.secret_enc) return; // nothing to recover; user can simply enrol
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO mfa_recovery_requests(user_id, requested_at, expires_at) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [u.id, now, new Date(now.getTime() + RECOVERY_REQUEST_TTL_HOURS * 3600_000)],
      );
      if (rows.length === 0) return;
      await this.audit.record(tx, { id: u.id, role: u.role }, 'mfa.recovery.requested', 'user', u.id, { requestId: rows[0].id });
      await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('MFA_RECOVERY_REQUESTED', $1)`, [JSON.stringify({ userId: u.id, requestId: rows[0].id })]);
    });
    // Same response whether or not a request was created.
    return { received: true };
  }

  async listRecoveryRequests() {
    return this.db.query(
      `SELECT r.id, r.status, r.requested_at, r.expires_at, r.approved_at, r.execute_after, u.email
         FROM mfa_recovery_requests r JOIN users u ON u.id = r.user_id ORDER BY r.requested_at DESC LIMIT 100`,
    );
  }

  /** Step 2 (a DIFFERENT administrator, with fresh step-up): approve after verifying the requester out-of-band. */
  async approveRecovery(approver: SessionInfo, requestId: string, note: string) {
    if (note.trim().length < 10) throw new DomainError('NOTE_REQUIRED', 'Describe how the requester was verified (min 10 chars)');
    const now = this.auth.now();
    const out = await this.db.transaction(async (tx) => {
      const [r] = await tx.query<any>('SELECT * FROM mfa_recovery_requests WHERE id=$1 FOR UPDATE', [requestId]);
      if (!r) return { err: new DomainError('NOT_FOUND', 'Request not found', 404) };
      if (r.user_id === approver.userId) return { err: new DomainError('SELF_APPROVAL_FORBIDDEN', 'You cannot approve your own recovery', 403) };
      if (r.status !== 'REQUESTED' || new Date(r.expires_at) <= now) return { err: new DomainError('NOT_APPROVABLE', `Request is ${r.status}`, 409) };
      const executeAfter = new Date(now.getTime() + this.opts.recoveryDelayHours * 3600_000);
      await tx.query(
        `UPDATE mfa_recovery_requests SET status='APPROVED', approved_by=$2, approved_at=$3, decision_note=$4, execute_after=$5, expires_at=$6 WHERE id=$1`,
        [requestId, approver.userId, now, note, executeAfter, new Date(executeAfter.getTime() + RECOVERY_REQUEST_TTL_HOURS * 3600_000)],
      );
      await this.audit.record(tx, actorOf(approver), 'mfa.recovery.approved', 'user', r.user_id, { requestId, executeAfter: executeAfter.toISOString() });
      await tx.query(`INSERT INTO notification_jobs(kind, payload) VALUES ('MFA_RECOVERY_APPROVED', $1)`, [JSON.stringify({ userId: r.user_id, requestId, executeAfter })]);
      return { executeAfter };
    });
    if ('err' in out && out.err) throw out.err;
    return { executeAfter: (out as { executeAfter: Date }).executeAfter };
  }

  async rejectRecovery(approver: SessionInfo, requestId: string, note: string) {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query<any>(`UPDATE mfa_recovery_requests SET status='REJECTED', decision_note=$2 WHERE id=$1 AND status IN ('REQUESTED','APPROVED') RETURNING user_id`, [requestId, note]);
      if (!rows.length) throw new DomainError('NOT_REJECTABLE', 'Request is not open', 409);
      await this.audit.record(tx, actorOf(approver), 'mfa.recovery.rejected', 'user', rows[0].user_id, { requestId });
    });
  }

  // ------------------------------------------------------------------ internals
  private async verifyFactor(tx: Queryable, session: SessionInfo, input: FactorInput, context: string, now: Date): Promise<FactorResult> {
    const [m] = await tx.query<any>('SELECT * FROM user_mfa WHERE user_id=$1 FOR UPDATE', [session.userId]); // serialises concurrent attempts
    if (!m?.secret_enc) return { ok: false, reason: 'not_enrolled' };
    if (m.locked_until && new Date(m.locked_until) > now) {
      await this.audit.record(tx, actorOf(session), 'mfa.challenge.rejected_locked', 'user', session.userId, { context });
      return { ok: false, reason: 'locked' };
    }

    if (input.recoveryCode !== undefined) {
      const hash = this.box.hashRecoveryCode(String(input.recoveryCode));
      // Atomic single-use: only one concurrent caller can flip used_at from NULL.
      const used = await tx.query(`UPDATE mfa_recovery_codes SET used_at=$3 WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id`, [session.userId, hash, now]);
      if (used.length === 0) {
        const lockedNow = await this.registerFailure(tx, session, m, context, 'invalid_recovery_code', now);
        return { ok: false, reason: 'invalid', lockedNow };
      }
      await tx.query('UPDATE user_mfa SET failed_attempts=0, updated_at=$2 WHERE user_id=$1', [session.userId, now]);
      const [c] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [session.userId]);
      const remaining = Number(c.n);
      await this.audit.record(tx, actorOf(session), 'mfa.recovery_code.used', 'user', session.userId, { context, remaining });
      if (remaining <= 2) await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('MFA_RECOVERY_CODES_LOW', $1)`, [JSON.stringify({ userId: session.userId, remaining })]);
      return { ok: true, method: 'recovery', remainingCodes: remaining };
    }

    const secret = this.box.decrypt(m.secret_enc, session.userId);
    const step = matchTotp(secret, normaliseCode(input.code ?? ''), now.getTime());
    if (step === null) {
      const lockedNow = await this.registerFailure(tx, session, m, context, 'invalid_code', now);
      return { ok: false, reason: 'invalid', lockedNow };
    }
    if (step <= Number(m.last_used_step)) {
      const lockedNow = await this.registerFailure(tx, session, m, context, 'replayed_code', now);
      return { ok: false, reason: 'replay', lockedNow };
    }
    await tx.query('UPDATE user_mfa SET last_used_step=$2, failed_attempts=0, updated_at=$3 WHERE user_id=$1', [session.userId, step, now]);
    await this.audit.record(tx, actorOf(session), context === 'step_up' ? 'mfa.stepup.succeeded' : 'mfa.challenge.succeeded', 'user', session.userId, { context, method: 'totp' });
    return { ok: true, method: 'totp', step };
  }

  /** Records a failed attempt; locks the factor (and revokes the attempting session) at the limit. Returns true if locked now. */
  private async registerFailure(tx: Queryable, session: SessionInfo, m: any, context: string, reason: string, now: Date): Promise<boolean> {
    const attempts = Number(m.failed_attempts) + 1;
    const lock = attempts >= this.opts.maxMfaAttempts;
    await tx.query('UPDATE user_mfa SET failed_attempts=$2, locked_until=$3, updated_at=$4 WHERE user_id=$1', [
      session.userId,
      lock ? 0 : attempts,
      lock ? new Date(now.getTime() + this.opts.mfaLockMinutes * 60_000) : m.locked_until,
      now,
    ]);
    await this.audit.record(tx, actorOf(session), context === 'step_up' ? 'mfa.stepup.failed' : 'mfa.challenge.failed', 'user', session.userId, { context, reason, consecutiveFailures: attempts });
    if (lock) {
      await this.auth.revokeSession(tx, session.id, 'mfa_lockout');
      await this.audit.record(tx, actorOf(session), 'mfa.locked', 'user', session.userId, { minutes: this.opts.mfaLockMinutes });
      await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('MFA_LOCKOUT', $1)`, [JSON.stringify({ userId: session.userId })]);
    }
    return lock;
  }

  private async cancelOpenRecovery(tx: Queryable, session: SessionInfo, why: string) {
    const rows = await tx.query<{ id: string }>(`UPDATE mfa_recovery_requests SET status='CANCELLED' WHERE user_id=$1 AND status IN ('REQUESTED','APPROVED') RETURNING id`, [session.userId]);
    for (const r of rows) await this.audit.record(tx, actorOf(session), 'mfa.recovery.cancelled', 'user', session.userId, { requestId: r.id, why });
  }

  private async replaceRecoveryCodes(tx: Queryable, userId: string): Promise<string[]> {
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    for (const c of codes) await tx.query('INSERT INTO mfa_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [userId, this.box.hashRecoveryCode(c)]);
    return codes;
  }
}

const normaliseCode = (c: string) => String(c).replace(/\s+/g, '');
const invalidCode = () => new DomainError('INVALID_MFA_CODE', 'Invalid or expired code', 401);
const lockedError = () => new DomainError('MFA_LOCKED', 'Too many failed attempts. Try again later.', 429);

function failureError(r: Extract<FactorResult, { ok: false }>): DomainError {
  if (r.reason === 'locked' || r.lockedNow) return lockedError();
  if (r.reason === 'not_enrolled') return new DomainError('MFA_NOT_ENROLLED', 'MFA is not enrolled', 409);
  return invalidCode(); // invalid and replayed codes are indistinguishable to the caller
}
