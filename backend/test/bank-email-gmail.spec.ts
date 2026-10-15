import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../src/app';
import { TransientError } from '../src/common/errors';
import { GOOGLE_DEFAULTS } from '../src/bankmail/gmail';
import { boot, ingest, makeAlert, newOrder, orderRow, MockGoogle, startMockGoogle, stopMock, World } from './bank-email-helpers';

// ALL BANK EMAILS ARE SYNTHETIC; Google is a local mock. This does NOT prove the integration works against the real Gmail API.
jest.setTimeout(180_000);

let w: World;
let g: MockGoogle;
const WEB = 'http://web.test';

const googleCfg = () => ({
  clientId: 'client-id-123',
  clientSecret: 'client-secret-456',
  redirectUri: 'http://api.test/auth/google/callback',
  authUrl: 'https://accounts.example/o/oauth2/v2/auth',
  tokenUrl: `${g.url}/token`,
  revokeUrl: `${g.url}/revoke`,
  apiBase: `${g.url}/gmail`,
});

async function bootWithGoogle(opts: Parameters<typeof boot>[0] = {}, mailbox: Record<string, unknown> = {}) {
  g = await startMockGoogle();
  w = await boot({ ...opts, ops: { webBaseUrl: WEB, bankmail: { google: googleCfg(), mailbox: { syncIntervalSeconds: 60, ...mailbox } } } });
}
afterEach(async () => {
  await w?.db.close();
  if (g) await stopMock(g);
});

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
async function connect(): Promise<string> {
  const { url } = await w.p.mailbox.beginConnect(w.admin);
  await w.p.mailbox.completeConnect('auth-code-1', stateOf(url));
  return url;
}
const addMail = (id: string, raw: Buffer, internalDate = Date.now()) => g.state.messages.set(id, { raw, internalDate });
const conn = async () => (await w.db.query<any>(`SELECT * FROM mailbox_connections WHERE status <> 'DISCONNECTED'`))[0];

describe('connecting Gmail with OAuth (read-only, PKCE, no password)', () => {
  beforeEach(() => bootWithGoogle());

  it('builds a consent URL for the read-only scope only, with PKCE, and keeps the verifier and state off disk in clear', async () => {
    const { url } = await w.p.mailbox.beginConnect(w.admin);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.example/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'client-id-123', redirect_uri: 'http://api.test/auth/google/callback', response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', code_challenge_method: 'S256',
    });
    expect(u.searchParams.get('client_secret')).toBeNull(); // the secret never goes through the browser
    const state = u.searchParams.get('state')!;
    const rows = JSON.stringify(await w.db.query('SELECT * FROM oauth_states'));
    expect(rows).not.toContain(state);
    expect(rows).not.toContain(u.searchParams.get('code_challenge')!);
    expect((await w.db.query('SELECT 1 FROM audit_logs WHERE action=$1', ['mailbox.connect_started'])).length).toBe(1);
  });

  it('exchanges the code with the matching PKCE verifier, stores the refresh token encrypted, and records who connected', async () => {
    const url = await connect();
    const t = g.state.tokenCalls[0];
    expect(t).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code-1', client_id: 'client-id-123', client_secret: 'client-secret-456' });
    expect(createHash('sha256').update(t.code_verifier).digest('base64url')).toBe(new URL(url).searchParams.get('code_challenge')); // PKCE binds the exchange to this attempt
    const c = await conn();
    expect(c).toMatchObject({ email: 'owner@example.test', status: 'CONNECTED', provider: 'gmail', connected_by: w.admin.id });
    expect(c.refresh_token_enc.startsWith('v1.')).toBe(true);
    const dump = JSON.stringify([await w.db.query('SELECT * FROM mailbox_connections'), await w.db.query('SELECT * FROM audit_logs'), await w.db.query('SELECT * FROM alerts')]);
    expect(dump).not.toContain('rt-SECRET');
    expect(await w.p.mailbox.status()).toMatchObject({ gmailConfigured: true, connection: { email: 'owner@example.test', status: 'CONNECTED' } });
  });

  it('refuses an unknown, reused or expired state', async () => {
    await expect(w.p.mailbox.completeConnect('c', 'made-up-state')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const { url } = await w.p.mailbox.beginConnect(w.admin);
    await w.p.mailbox.completeConnect('c', stateOf(url));
    await expect(w.p.mailbox.completeConnect('c', stateOf(url))).rejects.toMatchObject({ code: 'INVALID_STATE' }); // single use
    const { url: url2 } = await w.p.mailbox.beginConnect(w.admin);
    await w.db.query(`UPDATE oauth_states SET expires_at = now() - interval '1 minute'`);
    await expect(w.p.mailbox.completeConnect('c', stateOf(url2))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it.each([
    ['broader mail permissions than needed', { scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify' }],
    ['full mailbox access', { scope: 'https://mail.google.com/' }],
    ['read-only access not granted', { scope: 'openid email' }],
  ])('refuses %s', async (_n, patch) => {
    g.state.scope = patch.scope;
    const { url } = await w.p.mailbox.beginConnect(w.admin);
    await expect(w.p.mailbox.completeConnect('c', stateOf(url))).rejects.toMatchObject({ code: 'GMAIL_AUTHORISATION_REFUSED' });
    expect(await conn()).toBeUndefined();
  });

  it('is not available without OAuth client credentials', async () => {
    await w.db.close();
    await stopMock(g);
    w = await boot();
    await expect(w.p.mailbox.beginConnect(w.admin)).rejects.toMatchObject({ code: 'GMAIL_NOT_CONFIGURED', status: 501 });
  });

  it('disconnecting revokes the token at Google, deletes it locally and stops syncing; a new connection replaces an old one', async () => {
    await connect();
    await expect(w.p.mailbox.sync()).resolves.toBe(0);
    await w.p.mailbox.disconnect(w.admin);
    expect(g.state.revoked).toEqual(['rt-SECRET-refresh-token-123']);
    expect(await conn()).toBeUndefined();
    expect((await w.db.query<any>(`SELECT refresh_token_enc FROM mailbox_connections`))[0].refresh_token_enc).toBe('revoked');
    await expect(w.p.mailbox.sync()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(w.p.mailbox.disconnect(w.admin)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await connect();
    await connect(); // replaces
    expect((await w.db.query(`SELECT 1 FROM mailbox_connections WHERE status <> 'DISCONNECTED'`)).length).toBe(1);
  });
});

describe('syncing alerts from Gmail', () => {
  beforeEach(() => bootWithGoogle());

  it('reads only mail from the allowlisted bank sender, processes each message once, and confirms the order', async () => {
    await connect();
    const o = await newOrder(w);
    const genuine = await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id });
    const forged = await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, sign: false });
    addMail('g-1', genuine);
    addMail('g-2', forged);
    expect(await w.p.mailbox.sync()).toBe(2);
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    expect((await w.db.query<any>(`SELECT source_message_id, status FROM mail_messages ORDER BY source_message_id`)).map((r) => [r.source_message_id, r.status])).toEqual([['g-1', 'CREDIT_RECORDED'], ['g-2', 'AUTH_FAILED']]);
    expect(g.state.listCalls[0]).toMatch(/^from:\(alerts@testbank\.example\) after:\d+$/); // only the configured bank sender is requested
    expect(await w.p.mailbox.sync()).toBe(0); // nothing is processed twice
    expect((await w.db.query('SELECT 1 FROM bank_credits')).length).toBe(1);
    const c = await conn();
    expect(c.last_error).toBeNull();
    expect(c.last_sync_at).not.toBeNull();
    expect(g.state.tokenCalls.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(1); // access token cached between syncs
  });

  it('uses Gmail\'s own receipt time, so a delayed message is still judged against when the money arrived', async () => {
    await connect();
    const o = await newOrder(w, 125_000, { minutes: 30 });
    const creditTime = new Date(Date.now() + 60_000);
    addMail('late', await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: creditTime }), creditTime.getTime() + 20 * 60_000);
    await w.p.mailbox.sync();
    expect((await orderRow(w, o.id)).status).toBe('PAID');
  });

  it('retries with backoff on Google outages, alerts after repeated failures, and recovers by itself', async () => {
    await connect();
    g.state.failList = 3;
    await expect(w.p.mailbox.sync()).rejects.toBeInstanceOf(TransientError);
    let c = await conn();
    expect(c).toMatchObject({ consecutive_failures: 1, status: 'CONNECTED' });
    expect(new Date(c.next_sync_at).getTime()).toBeGreaterThan(Date.now());
    expect(await w.p.mailbox.syncIfDue()).toEqual({ ran: false }); // not due yet: backoff respected
    await w.db.query(`UPDATE mailbox_connections SET next_sync_at = now() - interval '1 second'`);
    await expect(w.p.mailbox.syncIfDue()).rejects.toBeInstanceOf(TransientError);
    await w.db.query(`UPDATE mailbox_connections SET next_sync_at = now() - interval '1 second'`);
    await expect(w.p.mailbox.syncIfDue()).rejects.toBeInstanceOf(TransientError);
    c = await conn();
    expect(c.consecutive_failures).toBe(3);
    expect((await w.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['MAILBOX_SYNC_FAILING'])).length).toBe(1);
    // Google recovers; the next due sync succeeds and clears the failure state. Nothing was lost meanwhile.
    const o = await newOrder(w);
    addMail('after-outage', await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
    await w.db.query(`UPDATE mailbox_connections SET next_sync_at = now() - interval '1 second'`);
    expect(await w.p.mailbox.syncIfDue()).toEqual({ ran: true, processed: 1 });
    expect(await conn()).toMatchObject({ consecutive_failures: 0, last_error: null });
    expect((await orderRow(w, o.id)).status).toBe('PAID');
  });

  it.each([
    ['Gmail rejecting the access token', (s: MockGoogle['state']) => (s.listStatus = 401)],
    ['Google revoking the refresh token', (s: MockGoogle['state']) => (s.refreshStatus = 400)],
  ])('%s needs the operator to reconnect: syncing stops and an alert is raised', async (_n, breakIt) => {
    await connect();
    breakIt(g.state);
    await expect(w.p.mailbox.sync()).rejects.toThrow();
    const [c] = await w.db.query<any>('SELECT status, last_error FROM mailbox_connections');
    expect(c.status).toBe('ERROR');
    expect(c.last_error).toContain('REAUTH_REQUIRED');
    expect(await w.p.mailbox.syncIfDue()).toEqual({ ran: false });
    expect((await w.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['MAILBOX_SYNC_FAILING'])).length).toBe(1);
  });

  it('never reads the mailbox when no alert template is active', async () => {
    await w.db.close();
    await stopMock(g);
    await bootWithGoogle({ activateTemplate: false });
    await connect();
    addMail('x', await makeAlert({ amountMinor: 125_000 }));
    expect(await w.p.mailbox.sync()).toBe(0);
    expect(g.state.listCalls).toEqual([]);
    expect((await conn()).last_error).toContain('no active alert template');
  });

  it('a message whose processing failed is fetched and retried on a later sync without creating a duplicate', async () => {
    await connect();
    const o = await newOrder(w);
    const raw = await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id });
    addMail('flaky', raw);
    const orig = w.p.verification.applyProviderPayment.bind(w.p.verification);
    let fail = true;
    w.p.verification.applyProviderPayment = async (pp) => {
      if (fail) {
        fail = false;
        throw new Error('simulated crash');
      }
      return orig(pp);
    };
    await w.p.mailbox.sync(); // processing errors are recorded per message; the sync itself continues
    expect((await w.db.query<any>(`SELECT status, attempts FROM mail_messages WHERE source_message_id='flaky'`))[0]).toMatchObject({ status: 'ERROR', attempts: 1 });
    await w.db.query(`UPDATE mail_messages SET next_retry_at = now() - interval '1 second'`);
    await w.db.query(`UPDATE bank_credits SET created_at = now() - interval '5 minutes'`);
    await w.p.mailbox.sync();
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    expect((await w.db.query('SELECT 1 FROM payments')).length).toBe(1);
  });
});

describe('folder source and uploaded .eml (sandbox testing with saved emails)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-mail-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('processes .eml files from a folder through the same authenticity checks, once', async () => {
    w = await boot({ ops: { bankmail: { mailbox: { folderDir: dir } } } });
    const o = await newOrder(w);
    writeFileSync(join(dir, 'genuine.eml'), await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: new Date(Date.now() - 60_000) }));
    writeFileSync(join(dir, 'forged.eml'), await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, sign: false, at: new Date(Date.now() - 60_000) }));
    writeFileSync(join(dir, 'notes.txt'), 'not an email');
    expect(await w.p.mailbox.syncIfDue()).toEqual({ ran: true, processed: 2 });
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    expect((await w.db.query<any>(`SELECT source, status FROM mail_messages ORDER BY status`)).map((r) => `${r.source}:${r.status}`)).toEqual(['folder:AUTH_FAILED', 'folder:CREDIT_RECORDED']);
    expect(await w.p.mailbox.syncIfDue()).toEqual({ ran: true, processed: 0 });
  });

  it('an uploaded .eml goes through the FULL pipeline and is audited', async () => {
    w = await boot();
    const o = await newOrder(w);
    const out = await w.p.mailbox.ingestUploaded(await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: new Date(Date.now() - 60_000) }), w.admin);
    expect(out.creditStatus).toBe('MATCHED');
    const forged = await w.p.mailbox.ingestUploaded(await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, sign: false }), w.admin);
    expect(forged.status).toBe('AUTH_FAILED');
    expect((await w.db.query('SELECT 1 FROM audit_logs WHERE action=$1', ['mailbox.eml_uploaded'])).length).toBe(2);
    mkdirSync(dir, { recursive: true });
  });
});

describe('HTTP surface', () => {
  beforeEach(() => bootWithGoogle());

  it('the Google redirect returns the browser to the web app, reports failures as codes, and consumes the one-time state', async () => {
    const app = await createApp({ platform: w.p, jwtSecret: 'j'.repeat(40) });
    await app.init();
    const http = request(app.getHttpServer());
    try {
      const denied = await http.get('/auth/google/callback?error=access_denied').redirects(0);
      expect(denied.status).toBe(302);
      expect(denied.headers.location).toBe(`${WEB}/admin/mailbox?error=access_denied`);
      const bad = await http.get('/auth/google/callback?code=x&state=forged').redirects(0);
      expect(bad.headers.location).toBe(`${WEB}/admin/mailbox?error=INVALID_STATE`);
      const { url } = await w.p.mailbox.beginConnect(w.admin);
      const ok = await http.get(`/auth/google/callback?code=abc&state=${stateOf(url)}`).redirects(0);
      expect(ok.headers.location).toBe(`${WEB}/admin/mailbox?connected=1`);
      expect((await conn()).email).toBe('owner@example.test');
      const replay = await http.get(`/auth/google/callback?code=abc&state=${stateOf(url)}`).redirects(0);
      expect(replay.headers.location).toBe(`${WEB}/admin/mailbox?error=INVALID_STATE`);
    } finally {
      await app.close();
    }
  });

  it('every administrative collection, mailbox and template route requires authentication', async () => {
    const app = await createApp({ platform: w.p, jwtSecret: 'j'.repeat(40) });
    await app.init();
    const http = request(app.getHttpServer());
    try {
      for (const [m, path] of [['get', '/admin/collections/dashboard'], ['post', '/admin/collections/orders'], ['get', '/admin/collections/credits'], ['post', '/admin/mailbox/connect'], ['post', '/admin/mailbox/ingest-eml'], ['get', '/admin/alert-templates'], ['post', '/admin/alert-templates']] as const) {
        expect([path, (await (http as any)[m](path)).status]).toEqual([path, 401]);
      }
    } finally {
      await app.close();
    }
  });
});

void GOOGLE_DEFAULTS;
void ingest;
