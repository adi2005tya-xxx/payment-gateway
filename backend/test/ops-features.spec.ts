import { createServer } from 'http';
import { createHmac } from 'crypto';
import { migrate } from '../src/db/db';
import { PgliteDb } from '../src/db/pglite.db';
import { ACCOUNTS, merchantPayable } from '../src/ledger/ledger.service';
import { createPlatform, Platform } from '../src/platform';
import { SandboxBankAccountProvider } from '../src/provider/sandbox-bank.provider';
import { MemoryNotifier } from '../src/ops/notifications';
import { MemoryAlertSink, WebhookAlertSink, severityOf } from '../src/ops/alerts';
import { summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { hashPassword } from '../src/auth/password';
import { totpAt } from '../src/auth/totp';
import { Actor } from '../src/audit/audit.service';
import { testSecurity, WEBHOOK_SECRET } from './helpers';

jest.setTimeout(120_000);

let db: PgliteDb;
let provider: SandboxBankAccountProvider;
let p: Platform;
let admin1: Actor;
let admin2: Actor;
let notifier: MemoryNotifier;
let sink: MemoryAlertSink;
let offset = 0;
let n = 0;
const later = () => new Date(Date.now() + 30 * 24 * 3600 * 1000);

async function boot(upiLimit = 10_000_000) {
  offset = 0;
  db = await PgliteDb.open();
  await migrate(db);
  provider = new SandboxBankAccountProvider(WEBHOOK_SECRET, 'http://localhost:3001', 'gateway-test@sandboxbank', { upiPayoutLimitMinor: upiLimit });
  notifier = new MemoryNotifier();
  sink = new MemoryAlertSink();
  p = createPlatform(db, provider, testSecurity(() => new Date(Date.now() + offset)), { notifier, alertSink: sink, webBaseUrl: 'https://app.example.test' });
  const mk = async (email: string): Promise<Actor> => {
    const [u] = await db.query<any>(`INSERT INTO users(email, password_hash, role) VALUES ($1,'x','ADMIN') RETURNING id`, [email]);
    return { id: u.id, role: 'ADMIN' };
  };
  admin1 = await mk('a1@example.test');
  admin2 = await mk('a2@example.test');
}
async function merchant(opts: { reviewThreshold?: number } = {}) {
  const vpa = `shop${++n}.pay@okhdfc`;
  const reg = await p.merchants.register({ email: `m${n}@example.test`, passwordHash: 'x', legalName: 'Test Traders Pvt Ltd', displayName: 'Test Traders' });
  await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin1);
  const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
  provider.setVpaHolder(vpa, 'TEST TRADERS');
  const d = await p.merchants.addUpiDestination(reg.merchantId, vpa, actor);
  await p.merchants.verifyDestination(d.id, admin1);
  if (opts.reviewThreshold) await db.query('UPDATE merchants SET review_threshold_minor=$2 WHERE id=$1', [reg.merchantId, opts.reviewThreshold]);
  return { id: reg.merchantId, actor, vpa, email: `m${n}@example.test` };
}
async function fund(m: { id: string; actor: Actor }, amount: number) {
  const req = await p.requests.create(m.id, { orderReference: `O-${++n}`, amountMinor: amount }, m.actor);
  const sim = provider.simulateBankCredit(req.provider_order_id);
  await p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
  await p.jobs.drain(p.handlers);
}
const payable = (id: string) => p.ledger.balance(db, merchantPayable(id));
const status = async (id: string) => (await db.query<any>('SELECT status FROM payouts WHERE id=$1', [id]))[0].status;

afterEach(async () => {
  await db.close();
});

describe('payouts above the UPI per-transaction limit', () => {
  beforeEach(() => boot(50_000));

  it('are split into a group of transfers that are each reserved, sent, confirmed and reconciled; the request is idempotent as a whole', async () => {
    const m = await merchant();
    await fund(m, 100_000);
    await fund(m, 20_000); // payable 117,600
    const r = await p.payouts.request(m.id, { amountMinor: 117_600, idempotencyKey: 'big-payout' }, m.actor);
    expect(r.group.map((x: any) => Number(x.amount_minor))).toEqual([50_000, 50_000, 17_600]);
    expect(new Set(r.group.map((x: any) => x.payout_group)).size).toBe(1);
    expect(r.group.map((x: any) => x.idempotency_key)).toEqual(['big-payout#0', 'big-payout#1', 'big-payout#2']);
    expect(await payable(m.id)).toBe(0);
    await p.jobs.drain(p.handlers);
    for (const x of r.group) expect(await status(x.id)).toBe('SUCCEEDED');
    expect(provider.payoutCreateCalls).toBe(3);
    const again = await p.payouts.request(m.id, { amountMinor: 117_600, idempotencyKey: 'big-payout' }, m.actor);
    expect(again.group.map((x: any) => x.id)).toEqual(r.group.map((x: any) => x.id));
    expect(provider.payoutCreateCalls).toBe(3); // replay creates nothing
    await expect(p.payouts.request(m.id, { amountMinor: 100_000, idempotencyKey: 'big-payout' }, m.actor)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await p.reconciliation.run()).items).toEqual([]);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
  });

  it('a partly failed split leaves exactly the unpaid parts returned to the merchant', async () => {
    const m = await merchant();
    await fund(m, 100_000);
    const r = await p.payouts.request(m.id, { amountMinor: 98_000, idempotencyKey: 'partial' }, m.actor); // 50,000 + 48,000
    provider.topUp(-60_000); // owner account holds 40,000: neither part can be sent yet
    await p.jobs.drain(p.handlers);
    expect(provider.payoutCreateCalls).toBe(0);
    expect(await status(r.group[0].id)).toBe('QUEUED');
    provider.topUp(60_000 - 48_000 - 50_000 + 98_000); // enough for the first part only after it is sent? top up so balance = 50,000
    provider.topUp(50_000 - (await provider.getBalance()));
    await p.jobs.drain(p.handlers, later());
    const states = [await status(r.group[0].id), await status(r.group[1].id)];
    expect(states).toEqual(['SUCCEEDED', 'QUEUED']); // second part waits for liquidity, nothing is lost or doubled
    expect(provider.payoutCreateCalls).toBe(1);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
  });

  it('review and approval apply to the whole request, with dual control', async () => {
    const m = await merchant({ reviewThreshold: 10_000 });
    await fund(m, 100_000);
    const r = await p.payouts.request(m.id, { amountMinor: 98_000, idempotencyKey: 'held' }, m.actor);
    expect(r.group.map((x: any) => x.status)).toEqual(['UNDER_REVIEW', 'UNDER_REVIEW']);
    await p.jobs.drain(p.handlers);
    expect(provider.payoutCreateCalls).toBe(0);
    await expect(p.payouts.approve(r.group[1].id, { id: m.actor.id, role: 'MERCHANT' })).rejects.toMatchObject({ code: 'DUAL_APPROVAL_REQUIRED' });
    await p.payouts.approve(r.group[1].id, admin2); // approving any part approves all
    await p.jobs.drain(p.handlers);
    for (const x of r.group) expect(await status(x.id)).toBe('SUCCEEDED');
  });

  it('rejecting a held split releases every part', async () => {
    const m = await merchant({ reviewThreshold: 10_000 });
    await fund(m, 100_000);
    const r = await p.payouts.request(m.id, { amountMinor: 98_000, idempotencyKey: 'rej' }, m.actor);
    await p.payouts.reject(r.group[0].id, admin2, 'suspicious');
    for (const x of r.group) expect(await status(x.id)).toBe('FAILED');
    expect(await payable(m.id)).toBe(98_000);
  });
});

describe('adopting provider payouts a restored database never recorded', () => {
  beforeEach(() => boot());
  async function orphan(m: { vpa: string; id: string }, amount: number) {
    const ben = await provider.registerUpiBeneficiary(m.vpa);
    return provider.createPayout({ referenceId: 'lost-reference-1', amountMinor: amount, currency: 'INR', destinationRef: ben.ref, idempotencyKey: 'lost-1' });
  }

  it('records it under dual control using the provider amount; reconciliation then goes clean and balances stay consistent', async () => {
    const m = await merchant();
    await fund(m, 100_000);
    provider.topUp(100_000);
    const op = await orphan(m, 40_000);
    expect((await p.reconciliation.run()).items.map((i) => i.kind)).toContain('ORPHAN_PROVIDER_PAYOUT');

    const prop = await p.recovery.proposeAdoption(admin1, op.id, m.id, 'Matched to merchant by bank statement line 42');
    expect(prop.amountMinor).toBe(40_000); // amount comes from the provider, there is no amount input
    await expect(p.recovery.decideAdoption(admin1, prop.id, 'APPLY')).rejects.toMatchObject({ code: 'DUAL_APPROVAL_REQUIRED' });
    await expect(p.recovery.proposeAdoption(admin2, op.id, m.id, 'Second proposal for the same payout')).rejects.toMatchObject({ code: 'ALREADY_PROPOSED' });
    const done = await p.recovery.decideAdoption(admin2, prop.id, 'APPLY');
    expect(done).toMatchObject({ applied: true, amountMinor: 40_000, status: 'SUCCEEDED' });
    expect(await payable(m.id)).toBe(98_000 - 40_000);
    await expect(p.recovery.decideAdoption(admin2, prop.id, 'APPLY')).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
    await expect(p.recovery.proposeAdoption(admin2, op.id, m.id, 'Proposal after it was already adopted')).rejects.toMatchObject({ code: 'ALREADY_RECORDED' });
    expect((await p.reconciliation.run()).items).toEqual([]);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
    const actions = (await db.query<any>(`SELECT action FROM audit_logs WHERE action LIKE 'recovery.adoption.%' ORDER BY id`)).map((r) => r.action);
    expect(actions).toEqual(['recovery.adoption.proposed', 'recovery.adoption.applied']);
  });

  it('adopts an in-flight payout as PROCESSING, and refuses payouts where no money moved', async () => {
    const m = await merchant();
    await fund(m, 100_000);
    provider.topUp(100_000);
    provider.payoutBehavior = 'processing';
    const op = await orphan(m, 10_000);
    const prop = await p.recovery.proposeAdoption(admin1, op.id, m.id, 'Seen in provider dashboard as processing');
    expect((await p.recovery.decideAdoption(admin2, prop.id, 'APPLY')).status).toBe('PROCESSING');
    provider.settlePayout(op.id, 'processed');
    await p.reconciliation.run(); // syncs the in-flight payout to its final state
    expect(await status((await db.query<any>(`SELECT id FROM payouts WHERE provider_payout_id=$1`, [op.id]))[0].id)).toBe('SUCCEEDED');
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);

    provider.payoutBehavior = 'fail';
    const ben = await provider.registerUpiBeneficiary(m.vpa);
    const failed = await provider.createPayout({ referenceId: 'lost-2', amountMinor: 1000, currency: 'INR', destinationRef: ben.ref, idempotencyKey: 'lost-2' });
    await expect(p.recovery.proposeAdoption(admin1, failed.id, m.id, 'This one failed at the bank so nothing moved')).rejects.toMatchObject({ code: 'NOTHING_TO_ADOPT' });
    await expect(p.recovery.proposeAdoption(admin1, 'nope', m.id, 'There is no such payout at all')).rejects.toMatchObject({ code: 'NOT_AT_PROVIDER' });
  });

  it('can be rejected, and requires a real explanation', async () => {
    const m = await merchant();
    provider.topUp(50_000);
    const op = await orphan(m, 5_000);
    await expect(p.recovery.proposeAdoption(admin1, op.id, m.id, 'short')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    const prop = await p.recovery.proposeAdoption(admin1, op.id, m.id, 'Looks like a payout to this merchant');
    await p.recovery.decideAdoption(admin2, prop.id, 'REJECT');
    expect((await db.query('SELECT 1 FROM payouts WHERE provider_payout_id=$1', [op.id])).length).toBe(0);
    expect((await p.reconciliation.run()).items.map((i) => i.kind)).toContain('ORPHAN_PROVIDER_PAYOUT'); // still unresolved: release stays blocked
  });
});

describe('notifications', () => {
  beforeEach(() => boot());

  it('delivers merchant emails with amounts and a masked destination, once, with retries on failure', async () => {
    const m = await merchant();
    await fund(m, 100_000);
    await p.payouts.request(m.id, { idempotencyKey: 'n1' }, m.actor);
    await p.jobs.drain(p.handlers);
    notifier.failNext = 1;
    const first = await p.notifications.dispatchDue();
    expect(first.failed).toBe(1);
    expect((await db.query<any>(`SELECT COUNT(*)::int n FROM notification_jobs WHERE status='PENDING'`))[0].n).toBe(1);
    await p.notifications.dispatchDue(later());
    expect(await p.notifications.dispatchDue(later())).toEqual({ sent: 0, failed: 0, skipped: 0 }); // nothing left; never re-sent
    const subjects = notifier.sent.map((x) => x.subject).sort();
    expect(subjects).toEqual(['Payment received', 'Settlement completed']);
    const settled = notifier.sent.find((x) => x.subject === 'Settlement completed')!;
    expect(settled.to).toBe(m.email);
    expect(settled.text).toContain('INR 980.00');
    expect(settled.text).toContain('****@okhdfc');
    expect(JSON.stringify(notifier.sent).includes(m.vpa)).toBe(false); // raw UPI ID never in a message
  });

  it('marks notifications without any recipient as skipped and gives up after repeated failures', async () => {
    await db.query(`INSERT INTO notification_jobs(kind, payload) VALUES ('PAYMENT_RECEIVED','{}')`);
    expect((await p.notifications.dispatchDue()).skipped).toBe(1);
    const m = await merchant();
    await db.query(`INSERT INTO notification_jobs(merchant_id, kind, payload) VALUES ($1,'REFUND_PROCESSED','{"refundId":"r1"}')`, [m.id]);
    notifier.failNext = 100;
    for (let i = 1; i <= 9; i++) await p.notifications.dispatchDue(new Date(Date.now() + i * 2 * 3600_000));
    expect((await db.query<any>(`SELECT status, attempts FROM notification_jobs WHERE kind='REFUND_PROCESSED'`))[0]).toMatchObject({ status: 'FAILED', attempts: 8 });
  });
});

describe('password reset', () => {
  beforeEach(() => boot());
  const PW = 'a-brand-new-passphrase';
  async function user(email: string, role = 'MERCHANT') {
    const [u] = await db.query<any>(`INSERT INTO users(email, password_hash, role) VALUES ($1,$2,$3) RETURNING id`, [email, await hashPassword('old-passphrase-123'), role]);
    return u.id as string;
  }
  const tokenFromMail = () => /token=([A-Za-z0-9_-]+)/.exec(notifier.sent.at(-1)!.text)![1];

  it('emails a single-use link; the token is never stored in clear; the password changes, sessions die, the old password stops working', async () => {
    const id = await user('reset@example.test');
    const login = await p.auth.login('reset@example.test', 'old-passphrase-123');
    expect(await p.auth.resolve(login.session.id)).not.toBeNull();
    expect(await p.auth.requestPasswordReset('reset@example.test')).toEqual({ received: true });
    expect(await p.auth.requestPasswordReset('nobody@example.test')).toEqual({ received: true }); // same reply: no enumeration
    expect((await db.query('SELECT 1 FROM password_resets')).length).toBe(1);
    await p.notifications.dispatchDue();
    const mail = notifier.sent.at(-1)!;
    expect(mail.to).toBe('reset@example.test');
    expect(mail.text).toContain('https://app.example.test/reset-password?token=');
    const token = tokenFromMail();
    // Not stored in clear anywhere (reset row holds a hash; the queue row held it encrypted and is scrubbed after sending).
    const dump = JSON.stringify([await db.query('SELECT * FROM password_resets'), await db.query('SELECT * FROM notification_jobs'), await db.query('SELECT * FROM audit_logs')]);
    expect(dump.includes(token)).toBe(false);
    expect((await db.query<any>(`SELECT payload FROM notification_jobs WHERE kind='PASSWORD_RESET'`))[0].payload).toEqual({ scrubbed: true });

    await expect(p.auth.confirmPasswordReset(token, 'short')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(p.auth.confirmPasswordReset('x'.repeat(43), PW)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    await p.auth.confirmPasswordReset(token, PW);
    await expect(p.auth.confirmPasswordReset(token, PW)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' }); // single use
    expect(await p.auth.resolve(login.session.id)).toBeNull(); // existing sessions revoked
    await expect(p.auth.login('reset@example.test', 'old-passphrase-123')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect((await p.auth.login('reset@example.test', PW)).user.id).toBe(id);
    expect(await (async () => (await db.query<any>(`SELECT action FROM audit_logs WHERE subject_id=$1 AND action LIKE 'auth.password_reset%' ORDER BY id`, [id])).map((r) => r.action))()).toEqual(['auth.password_reset.requested', 'auth.password_reset.completed']);
  });

  it('expires after 30 minutes, is replaced by a newer request, and is rate limited per account', async () => {
    await user('exp@example.test');
    await p.auth.requestPasswordReset('exp@example.test');
    await p.notifications.dispatchDue();
    const old = tokenFromMail();
    await p.auth.requestPasswordReset('exp@example.test'); // newer request invalidates the older token
    await p.notifications.dispatchDue();
    const fresh = tokenFromMail();
    await expect(p.auth.confirmPasswordReset(old, PW)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    offset = 31 * 60_000;
    await expect(p.auth.confirmPasswordReset(fresh, PW)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    offset = 0;
    await p.auth.requestPasswordReset('exp@example.test');
    await p.auth.requestPasswordReset('exp@example.test'); // 4th within an hour: silently not issued
    expect((await db.query('SELECT 1 FROM password_resets')).length).toBe(3);
  });

  it('never weakens MFA: an administrator who resets their password must still pass the second factor', async () => {
    await user('admin-reset@example.test', 'ADMIN');
    const l1 = await p.auth.login('admin-reset@example.test', 'old-passphrase-123');
    const s1 = (await p.auth.resolve(l1.session.id))!;
    const st = await p.mfa.startEnrol(s1);
    await p.mfa.confirmEnrol(s1, totpAt(st.secret, Date.now()));
    await p.auth.requestPasswordReset('admin-reset@example.test');
    await p.notifications.dispatchDue();
    await p.auth.confirmPasswordReset(tokenFromMail(), PW);
    const l2 = await p.auth.login('admin-reset@example.test', PW);
    expect(l2.mfa).toBe('CHALLENGE_REQUIRED');
    expect((await db.query('SELECT 1 FROM user_mfa WHERE secret_enc IS NOT NULL')).length).toBe(1);
  });
});

describe('alert routing and the ops monitor', () => {
  beforeEach(() => boot());

  it('turns silent conditions into deduplicated alerts and routes them with a severity', async () => {
    await db.query(`INSERT INTO jobs(kind, payload, run_at) VALUES ('process_webhook','{}', now() - interval '20 minutes')`);
    await db.query(`INSERT INTO webhook_events(provider, provider_event_id, event_type, payload, received_at) VALUES ('owner-account','e1','payment.credited','{}', now() - interval '30 minutes')`);
    expect((await p.monitor.runChecks({ fullAudit: true })).sort()).toEqual(['JOBS_LATE', 'WEBHOOK_BACKLOG']);
    expect(await p.monitor.runChecks()).toEqual([]); // one per kind per hour
    expect(await p.alerts.routeDue()).toEqual({ routed: 2, failed: 0 });
    expect(await p.alerts.routeDue()).toEqual({ routed: 0, failed: 0 }); // already routed
    expect(sink.sent.map((a) => [a.kind, a.severity]).sort()).toEqual([['JOBS_LATE', 'warning'], ['WEBHOOK_BACKLOG', 'warning']]);
    expect(severityOf('MONEY_OUT_FROZEN')).toBe('critical');
    expect(severityOf('SOMETHING_NEW')).toBe('info');
  });

  it('detects a tampered ledger and a broken audit chain', async () => {
    const m = await merchant();
    await fund(m, 100_000);
    await db.exec(`ALTER TABLE audit_logs DISABLE TRIGGER USER; UPDATE audit_logs SET action='x' WHERE id=(SELECT MIN(id) FROM audit_logs)`);
    expect(await p.monitor.runChecks({ fullAudit: true })).toContain('AUDIT_CHAIN_BROKEN');
    expect(severityOf('AUDIT_CHAIN_BROKEN')).toBe('critical');
  });

  it('delivers to a webhook endpoint with an HMAC signature, honours the minimum severity, and retries failures', async () => {
    const got: Array<{ body: string; sig?: string }> = [];
    let fail = true;
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (fail) {
          res.statusCode = 503;
          return res.end();
        }
        got.push({ body: b, sig: req.headers['x-gateway-signature'] as string });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
    const router = createPlatform(db, provider, testSecurity(() => new Date()), { alertSink: new WebhookAlertSink(url, 'sink-secret', 'warning') });
    await db.query(`INSERT INTO alerts(kind, detail) VALUES ('MONEY_OUT_FROZEN','{"reason":"test"}'), ('POST_RESTORE_COMPLETED','{}')`);
    expect(await router.alerts.routeDue()).toEqual({ routed: 1, failed: 1 }); // endpoint down: the critical alert is kept for retry (the info one is below the threshold, so it is simply handled)
    fail = false;
    expect(await router.alerts.routeDue()).toEqual({ routed: 1, failed: 0 });
    srv.closeAllConnections();
    srv.close();
    expect(got).toHaveLength(1); // the info-level alert is below the threshold: marked handled, not sent
    const only = got[0];
    expect(JSON.parse(only.body)).toMatchObject({ kind: 'MONEY_OUT_FROZEN', severity: 'critical' });
    expect(only.sig).toBe(createHmac('sha256', 'sink-secret').update(only.body).digest('hex'));
  });
});
