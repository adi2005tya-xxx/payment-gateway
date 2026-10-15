import { TransientError } from '../common/errors';

/** Thrown when Google says the authorisation is gone or invalid (revoked, expired, wrong scope). Needs the operator to reconnect. */
export class MailAuthError extends Error {}

export interface MailGateway {
  /** ids of messages from the given senders received after the epoch second */
  list(afterEpochSec: number, fromAddresses: string[]): Promise<string[]>;
  getRaw(id: string): Promise<{ raw: Buffer; receivedAt: Date }>;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
}
export const GOOGLE_DEFAULTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  apiBase: 'https://gmail.googleapis.com/gmail/v1',
};
/** Read-only. The application never sends, modifies or deletes mail. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const FORBIDDEN_SCOPES = ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.insert'];

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new TransientError('could not reach Google');
  }
}

/** OAuth 2.0 authorisation-code flow with PKCE. The operator signs in at Google; this app only ever receives tokens. */
export class GoogleOAuth {
  constructor(readonly cfg: GoogleOAuthConfig) {}

  authorizationUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.cfg.authUrl}?${q.toString()}`;
  }

  private async token(body: Record<string, string>) {
    const res = await call(this.cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }).toString() });
    const j: any = await res.json().catch(() => ({}));
    if (res.status >= 500 || res.status === 429) throw new TransientError(`token endpoint ${res.status}`);
    if (!res.ok) throw new MailAuthError(String(j.error ?? res.status));
    return j;
  }

  async exchange(code: string, codeVerifier: string) {
    const j = await this.token({ code, code_verifier: codeVerifier, redirect_uri: this.cfg.redirectUri, grant_type: 'authorization_code' });
    const scopes: string[] = String(j.scope ?? '').split(/\s+/).filter(Boolean);
    if (!j.refresh_token) throw new MailAuthError('no refresh token returned (revoke the app at Google and connect again)');
    if (!scopes.includes(GMAIL_SCOPE)) throw new MailAuthError('read-only Gmail access was not granted');
    if (scopes.some((s) => FORBIDDEN_SCOPES.includes(s))) throw new MailAuthError('broader mail permissions than needed were granted; refusing');
    return { refreshToken: String(j.refresh_token), accessToken: String(j.access_token), expiresInSec: Number(j.expires_in ?? 3600), scope: scopes.join(' ') };
  }

  async refresh(refreshToken: string) {
    const j = await this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' });
    return { accessToken: String(j.access_token), expiresInSec: Number(j.expires_in ?? 3600) };
  }

  async revoke(token: string) {
    await call(this.cfg.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() }).catch(() => undefined);
  }

  async profileEmail(accessToken: string): Promise<string> {
    const res = await call(`${this.cfg.apiBase}/users/me/profile`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new MailAuthError(`profile ${res.status}`);
    return String(((await res.json()) as any).emailAddress ?? '').toLowerCase();
  }
}

export class GmailGateway implements MailGateway {
  constructor(private readonly accessToken: () => Promise<string>, private readonly apiBase: string) {}

  private async get(path: string): Promise<any> {
    const res = await call(`${this.apiBase}${path}`, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 401 || res.status === 403) throw new MailAuthError(`gmail ${res.status}`);
    if (res.status === 429 || res.status >= 500) throw new TransientError(`gmail ${res.status}`);
    if (!res.ok) throw new Error(`gmail ${res.status}`);
    return res.json();
  }

  async list(afterEpochSec: number, fromAddresses: string[]): Promise<string[]> {
    const q = `from:(${fromAddresses.join(' OR ')}) after:${Math.floor(afterEpochSec)}`;
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const j = await this.get(`/users/me/messages?${new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) })}`);
      for (const m of j.messages ?? []) ids.push(String(m.id));
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  }

  async getRaw(id: string) {
    const j = await this.get(`/users/me/messages/${encodeURIComponent(id)}?format=raw`);
    return { raw: Buffer.from(String(j.raw), 'base64url'), receivedAt: new Date(Number(j.internalDate)) };
  }
}
