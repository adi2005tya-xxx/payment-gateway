import { createHash, randomBytes } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { DomainError, TransientError } from '../common/errors';
import { Db } from '../db/db';
import { Actor, AuditService, SYSTEM_ACTOR } from '../audit/audit.service';
import { SecretBox } from '../auth/secretbox';
import { GMAIL_SCOPE, GmailGateway, GoogleOAuth, MailAuthError, MailGateway } from './gmail';
import { AlertIngestService } from './ingest.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64u = (b: Buffer) => b.toString('base64url');
const minute = 60_000;

/** Sandbox/dev source: reads .eml files from a folder (e.g. a real bank email saved from your mail client). Same authenticity checks apply. */
export class FolderMailGateway implements MailGateway {
  constructor(private readonly dir: string) {}
  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.eml')).map((f) => `${f}:${statSync(join(this.dir, f)).size}:${Math.floor(statSync(join(this.dir, f)).mtimeMs)}`);
  }
  async getRaw(id: string) {
    const name = id.split(':')[0];
    if (name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error('bad id');
    const full = join(this.dir, name);
    return { raw: readFileSync(full), receivedAt: new Date(statSync(full).mtimeMs) };
  }
}

export interface MailboxOptions {
  now?: () => Date;
  syncIntervalSeconds: number;
  /** re-read this far back on every sync, so a message that arrived while the last sync ran is never missed */
  overlapMinutes: number;
  maxAlertAgeHours: number;
  folderDir?: string;
  /** web app base URL the Google consent redirect returns to */
  returnUrl?: string;
  /** builds the Gmail gateway; injectable for tests */
  gatewayFactory?: (accessToken: () => Promise<string>) => MailGateway;
  apiBase?: string;
}

/**
 * Connects the operator's Gmail with OAuth (the mailbox password is never seen), and pulls bank alert emails read-only.
 * The refresh token is stored AES-256-GCM encrypted. Failures retry with backoff; nothing is lost because messages are
 * identified by their Gmail id and re-read with an overlap window.
 */
export class MailboxService {
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
    private readonly oauth: GoogleOAuth | null,
    private readonly ingest: AlertIngestService,
    readonly opts: MailboxOptions,
  ) {}

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  get configured() {
    return !!this.oauth || !!this.opts.folderDir;
  }

  // ------------------------------------------------------------------ connect / disconnect
  async beginConnect(actor: Actor): Promise<{ url: string }> {
    if (!this.oauth) throw new DomainError('GMAIL_NOT_CONFIGURED', 'Gmail OAuth client credentials are not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)', 501);
    const state = b64u(randomBytes(24));
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash('sha256').update(verifier).digest());
    await this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO oauth_states(state_hash, user_id, code_verifier_enc, expires_at) VALUES ($1,$2,$3,$4)`, [sha(state), actor.id, this.box.encrypt(verifier, 'oauth-verifier'), new Date(this.now().getTime() + 10 * minute)]);
      await this.audit.record(tx, actor, 'mailbox.connect_started', 'mailbox', 'gmail');
    });
    return { url: this.oauth.authorizationUrl(state, challenge) };
  }

  /** Called by the redirect from Google. The one-time `state` (bound to the admin who started it) is the only credential here. */
  async completeConnect(code: string, state: string): Promise<{ email: string }> {
    if (!this.oauth) throw new DomainError('GMAIL_NOT_CONFIGURED', 'Gmail OAuth is not configured', 501);
    const rows = await this.db.query<any>(
      `UPDATE oauth_states SET used_at=$2 WHERE state_hash=$1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id, code_verifier_enc`,
      [sha(state), this.now()],
    );
    if (!rows.length) throw new DomainError('INVALID_STATE', 'This connection attempt is invalid or has expired; start again', 400);
    const verifier = this.box.decrypt(rows[0].code_verifier_enc, 'oauth-verifier');
    let tok;
    try {
      tok = await this.oauth.exchange(code, verifier);
    } catch (e: any) {
      if (e instanceof MailAuthError) throw new DomainError('GMAIL_AUTHORISATION_REFUSED', e.message, 400);
      throw new DomainError('GMAIL_UNAVAILABLE', 'Could not reach Google; try again', 503);
    }
    const email = await this.oauth.profileEmail(tok.accessToken);
    const actor: Actor = { id: rows[0].user_id, role: 'ADMIN' };
    await this.db.transaction(async (tx) => {
      const old = await tx.query<any>(`UPDATE mailbox_connections SET status='DISCONNECTED', refresh_token_enc='revoked' WHERE status <> 'DISCONNECTED' RETURNING id`);
      await tx.query(
        `INSERT INTO mailbox_connections(email, refresh_token_enc, scope, connected_by) VALUES ($1,$2,$3,$4)`,
        [email, this.box.encrypt(tok.refreshToken, 'gmail-refresh-token'), tok.scope, actor.id],
      );
      await this.audit.record(tx, actor, 'mailbox.connected', 'mailbox', email, { replaced: old.length, scope: tok.scope });
    });
    this.tokenCache.clear();
    return { email };
  }

  async status() {
    const [c] = await this.db.query<any>(`SELECT email, status, last_sync_at, last_error, consecutive_failures, created_at, scope FROM mailbox_connections WHERE status <> 'DISCONNECTED'`);
    const [m] = await this.db.query<any>(`SELECT COUNT(*) FILTER (WHERE status='CREDIT_RECORDED')::int AS credits, COUNT(*) FILTER (WHERE status IN ('AUTH_FAILED','UNPARSEABLE','ERROR','REJECTED'))::int AS problems, COUNT(*)::int AS total FROM mail_messages`);
    return {
      gmailConfigured: !!this.oauth,
      folderSource: this.opts.folderDir ? true : false,
      connection: c ? { email: c.email, status: c.status, lastSyncAt: c.last_sync_at, lastError: c.last_error, consecutiveFailures: c.consecutive_failures, since: c.created_at, scope: c.scope } : null,
      messages: m,
    };
  }

  async disconnect(actor: Actor) {
    const [c] = await this.db.query<any>(`SELECT id, refresh_token_enc FROM mailbox_connections WHERE status <> 'DISCONNECTED'`);
    if (!c) throw new DomainError('NOT_CONNECTED', 'No mailbox is connected', 409);
    if (this.oauth && c.refresh_token_enc !== 'revoked') {
      try {
        await this.oauth.revoke(this.box.decrypt(c.refresh_token_enc, 'gmail-refresh-token')); // best effort: also revoke at Google
      } catch {
        /* the token is deleted locally regardless */
      }
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE mailbox_connections SET status='DISCONNECTED', refresh_token_enc='revoked' WHERE id=$1`, [c.id]);
      await this.audit.record(tx, actor, 'mailbox.disconnected', 'mailbox', 'gmail');
    });
    this.tokenCache.clear();
  }

  // ------------------------------------------------------------------ sync
  private async accessToken(connId: string, encRefresh: string): Promise<string> {
    const hit = this.tokenCache.get(connId);
    if (hit && hit.expiresAt > this.now().getTime() + 60_000) return hit.token;
    if (!this.oauth) throw new MailAuthError('OAuth not configured');
    const r = await this.oauth.refresh(this.box.decrypt(encRefresh, 'gmail-refresh-token'));
    this.tokenCache.set(connId, { token: r.accessToken, expiresAt: this.now().getTime() + r.expiresInSec * 1000 });
    return r.accessToken;
  }

  private async fromAddresses(): Promise<string[]> {
    const defs = await this.db.query<any>(`SELECT definition FROM alert_templates WHERE status='ACTIVE'`);
    return [...new Set(defs.filter((d) => (d.definition.channel ?? 'email') === 'email').flatMap((d) => d.definition.fromAddresses as string[]))];
  }

  /** Runs a sync if one is due. Safe to call from a timer. */
  async syncIfDue(): Promise<{ ran: boolean; processed?: number }> {
    if (this.opts.folderDir) return { ran: true, processed: await this.syncFolder() };
    const [c] = await this.db.query<any>(`SELECT id FROM mailbox_connections WHERE status='CONNECTED' AND next_sync_at <= $1`, [this.now().toISOString()]);
    if (!c) return { ran: false };
    return { ran: true, processed: await this.sync() };
  }

  private async syncFolder(): Promise<number> {
    return this.drain(new FolderMailGateway(this.opts.folderDir!), 'folder', 0, []);
  }

  /** Pulls and processes alerts now. Returns how many new messages were processed. */
  async sync(): Promise<number> {
    const [c] = await this.db.query<any>(`SELECT * FROM mailbox_connections WHERE status='CONNECTED'`);
    if (!c) throw new DomainError('NOT_CONNECTED', 'No mailbox is connected', 409);
    const started = this.now();
    try {
      const addrs = await this.fromAddresses();
      if (!addrs.length) {
        await this.db.query(`UPDATE mailbox_connections SET last_sync_at=$2, last_error='no active alert template: nothing to look for', next_sync_at=$3 WHERE id=$1`, [c.id, started, new Date(started.getTime() + this.opts.syncIntervalSeconds * 1000)]);
        return 0; // never read the mailbox without a template saying what to look for
      }
      const gateway = (this.opts.gatewayFactory ?? ((tok) => new GmailGateway(tok, this.opts.apiBase ?? this.oauth!.cfg.apiBase)))(() => this.accessToken(c.id, c.refresh_token_enc));
      const since = c.last_sync_at ? new Date(c.last_sync_at).getTime() - this.opts.overlapMinutes * minute : started.getTime() - this.opts.maxAlertAgeHours * 3600_000;
      const n = await this.drain(gateway, 'gmail', Math.max(0, Math.floor(since / 1000)), addrs);
      await this.db.query(`UPDATE mailbox_connections SET last_sync_at=$2, last_error=NULL, consecutive_failures=0, next_sync_at=$3 WHERE id=$1`, [c.id, started, new Date(started.getTime() + this.opts.syncIntervalSeconds * 1000)]);
      return n;
    } catch (e: any) {
      await this.syncFailed(c, e);
      throw e;
    }
  }

  private async drain(gateway: MailGateway, source: string, afterEpoch: number, addrs: string[]): Promise<number> {
    const ids = await gateway.list(afterEpoch, addrs);
    const seen = new Set((await this.db.query<any>(`SELECT source_message_id FROM mail_messages WHERE source=$1 AND status <> 'ERROR'`, [source])).map((r) => r.source_message_id as string));
    let n = 0;
    const todo = [...ids.filter((i) => !seen.has(i))];
    for (const r of await this.ingest.retryDue()) if (r.source === source && !todo.includes(r.sourceMessageId)) todo.push(r.sourceMessageId);
    for (const id of todo) {
      const { raw, receivedAt } = await gateway.getRaw(id);
      await this.ingest.ingestRaw(raw, { source, sourceMessageId: id, receivedAt });
      n++;
    }
    await this.ingest.matchNew();
    return n;
  }

  private async syncFailed(c: any, e: any) {
    const reauth = e instanceof MailAuthError;
    const failures = Number(c.consecutive_failures) + 1;
    const delayMin = reauth ? 60 * 24 : Math.min(30, 2 ** failures);
    const msg = reauth ? 'REAUTH_REQUIRED: Google rejected the stored authorisation; reconnect the mailbox' : String(e?.message ?? e).slice(0, 150);
    await this.db.query(
      `UPDATE mailbox_connections SET consecutive_failures=$2, last_error=$3, status=$4, next_sync_at=$5 WHERE id=$1`,
      [c.id, failures, msg, reauth ? 'ERROR' : 'CONNECTED', new Date(this.now().getTime() + delayMin * minute)],
    );
    if (reauth || failures >= 3) {
      const [recent] = await this.db.query(`SELECT 1 FROM alerts WHERE kind='MAILBOX_SYNC_FAILING' AND created_at > now() - interval '1 hour'`);
      if (!recent) await this.db.query(`INSERT INTO alerts(kind, detail) VALUES ('MAILBOX_SYNC_FAILING', $1)`, [JSON.stringify({ failures, reauthRequired: reauth })]);
    }
    if (e instanceof TransientError) return;
  }

  /** Process one raw .eml supplied by an administrator (e.g. downloaded from the mail client) through the FULL pipeline. */
  async ingestUploaded(raw: Buffer, actor: Actor) {
    const out = await this.ingest.ingestRaw(raw, { source: 'upload', sourceMessageId: sha(raw.toString('latin1')), receivedAt: this.now() });
    await this.db.transaction((tx) => this.audit.record(tx, actor, 'mailbox.eml_uploaded', 'mail_message', out.messageId ?? 'n/a', { status: out.status, reason: out.reason }));
    return out;
  }
}

export { GMAIL_SCOPE, SYSTEM_ACTOR };
