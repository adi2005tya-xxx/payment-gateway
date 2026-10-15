import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { migrate } from '../src/db/db';
import { PgliteDb } from '../src/db/pglite.db';
import { ACCOUNTS, merchantPayable } from '../src/ledger/ledger.service';
import { createPlatform, Platform } from '../src/platform';
import { SandboxBankAccountProvider, maskVpa } from '../src/provider/sandbox-bank.provider';
import { SandboxProvider } from '../src/provider/sandbox.provider';
import { summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { Actor } from '../src/audit/audit.service';
import { testSecurity, WEBHOOK_SECRET } from './helpers';

jest.setTimeout(120_000);

const OWNER_VPA = 'gateway-test@sandboxbank';
const later = () => new Date(Date.now() + 30 * 24 * 3600 * 1000);
let db: PgliteDb;
let provider: SandboxBankAccountProvider;
let p: Platform;
let admin: Actor;
let n = 0;

async function boot(opts: { upiLimit?: number; opening?: number } = {}) {
  db = await PgliteDb.open();
  await migrate(db);
  provider = new SandboxBankAccountProvider(WEBHOOK_SECRET, 'http://localhost:3001', OWNER_VPA, { openingBalanceMinor: opts.opening ?? 0, upiPayoutLimitMinor: opts.upiLimit });
  p = createPlatform(db, provider, testSecurity(() => new Date()));
  const [u] = await db.query<any>(`INSERT INTO users(email, password_hash, role) VALUES ('boss@example.test','x','ADMIN') RETURNING id`);
  admin = { id: u.id, role: 'ADMIN' };
}

/** Approved merchant with a verified UPI payout destination. */
async function merchant(vpa = `shop${++n}.payments@okhdfc`, holder = 'TEST TRADERS') {
  const reg = await p.merchants.register({ email: `m${n}@example.test`, passwordHash: 'x', legalName: 'Test Traders Pvt Ltd', displayName: 'Test Traders' });
  await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin);
  const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
  provider.setVpaHolder(vpa, holder);
  const d = await p.merchants.addUpiDestination(reg.merchantId, vpa, actor);
  await p.merchants.verifyDestination(d.id, admin);
  return { id: reg.merchantId, actor, vpa, destId: d.id };
}
const payRequest = (m: { id: string; actor: Actor }, amount = 100_000) =>
  p.requests.create(m.id, { orderReference: `ORD-${++n}`, amountMinor: amount }, m.actor);
async function customerPays(reference: string | null, opts: { amountMinor?: number } = {}) {
  const sim = provider.simulateBankCredit(reference, opts);
  await p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
  await p.jobs.drain(p.handlers);
  return sim;
}
const payable = (id: string) => p.ledger.balance(db, merchantPayable(id));

beforeEach(async () => {
  await boot();
});
afterEach(async () => {
  await db.close();
});

describe('customer pays the owner account; platform confirms; merchant is paid by UPI', () => {
  it('full flow: unique reference in a UPI link -> bank credit -> verified -> ledger -> payout to the merchant UPI ID -> reconciled', async () => {
    const m = await merchant('rahul.traders@okhdfc');
    const req = await payRequest(m, 100_000);

    // The QR/link carries the OWNER'S UPI ID, the exact amount and a unique reference.
    const uri = new URL(req.qr_payload);
    expect(uri.protocol).toBe('upi:');
    expect(uri.searchParams.get('pa')).toBe(OWNER_VPA);
    expect(uri.searchParams.get('am')).toBe('1000.00');
    expect(uri.searchParams.get('cu')).toBe('INR');
    expect(uri.searchParams.get('tr')).toBe(req.provider_order_id);
    expect(req.provider_order_id).toMatch(/^GW[A-Z2-9]{10}$/);
    expect((await p.requests.publicView(req.public_token)).status).toBe('AWAITING_PAYMENT'); // not paid just because a QR exists

    // Money arrives in the owner's account: only now is it confirmed.
    const before = await provider.getBalance();
    const sim = await customerPays(req.provider_order_id);
    expect(await provider.getBalance()).toBe(before + 100_000);
    const [pay] = await db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
    expect(pay).toMatchObject({ status: 'SUCCEEDED', fee_minor: 2000, net_minor: 98_000, provider: 'owner-account' });
    expect(await payable(m.id)).toBe(98_000);
    expect((await p.requests.publicView(req.public_token)).status).toBe('PAID');

    // Payout to the merchant's UPI ID, from the same account.
    const po = await p.payouts.request(m.id, { idempotencyKey: 'upi-payout-1' }, m.actor);
    expect(po.amount_minor).toBe(98_000);
    await p.jobs.drain(p.handlers);
    expect((await db.query<any>('SELECT status FROM payouts WHERE id=$1', [po.id]))[0].status).toBe('SUCCEEDED');
    expect(await provider.getBalance()).toBe(before + 100_000 - 98_000);
    expect(await p.ledger.balance(db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(2000); // owner's platform fee stays in the account

    const run = await p.reconciliation.run();
    expect(run.items).toEqual([]);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
  });

  it('a credit that cannot be matched with certainty is held for review, never guessed or credited', async () => {
    const a = await merchant();
    const b = await merchant();
    const req = await payRequest(a, 100_000);

    const dropped = await customerPays(null, { amountMinor: 100_000 }); // customer's app lost the reference
    const typo = await customerPays('GWTYPO00000', { amountMinor: 100_000 });
    const wrongAmount = await customerPays(req.provider_order_id, { amountMinor: 90_000 });
    const sneaky = provider.simulateBankCredit(req.provider_order_id, { merchantRef: b.id }); // credit tied to the wrong merchant
    await p.verification.ingestWebhook(sneaky.webhook.body, sneaky.webhook.signature);
    await p.jobs.drain(p.handlers);

    for (const [sim, reason] of [[dropped, 'UNKNOWN_ORDER'], [typo, 'UNKNOWN_ORDER'], [wrongAmount, 'AMOUNT_MISMATCH']] as const) {
      const [pay] = await db.query<any>('SELECT status, verification_result FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
      expect(pay.status).toBe('UNDER_REVIEW');
      expect(pay.verification_result).toContain(reason);
    }
    const [s] = await db.query<any>('SELECT status, verification_result FROM payments WHERE provider_payment_id=$1', [sneaky.payment.id]);
    expect(s.status).toBe('UNDER_REVIEW');
    expect(await payable(a.id)).toBe(0);
    expect(await payable(b.id)).toBe(0);
    expect((await db.query('SELECT 1 FROM risk_reviews WHERE status=$1', ['OPEN'])).length).toBe(4);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
  });

  it('delivering the same bank credit twice credits once', async () => {
    const m = await merchant();
    const req = await payRequest(m);
    const sim = await customerPays(req.provider_order_id);
    expect((await p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature)).duplicate).toBe(true);
    await p.jobs.drain(p.handlers);
    expect(await payable(m.id)).toBe(98_000);
    expect((await db.query('SELECT 1 FROM ledger_journals WHERE kind=$1', ['COLLECTION'])).length).toBe(1);
  });

  it('a forged bank notification is rejected', async () => {
    const m = await merchant();
    const req = await payRequest(m);
    const sim = provider.simulateBankCredit(req.provider_order_id);
    await expect(p.verification.ingestWebhook(sim.webhook.body, 'bad')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});

describe('UPI payout rules', () => {
  it('a payout above the per-transaction UPI limit is split into allowed transfers, and the bank still refuses any over-limit transfer sent directly', async () => {
    await db.close();
    await boot({ upiLimit: 50_000 });
    const m = await merchant();
    await customerPays((await payRequest(m, 100_000)).provider_order_id);
    const po = await p.payouts.request(m.id, { idempotencyKey: 'big' }, m.actor); // 98,000 with a 50,000 cap -> 50,000 + 48,000
    expect(po.group.map((x: any) => Number(x.amount_minor))).toEqual([50_000, 48_000]);
    await p.jobs.drain(p.handlers);
    for (const x of po.group) expect((await db.query<any>('SELECT status FROM payouts WHERE id=$1', [x.id]))[0].status).toBe('SUCCEEDED');
    expect(await provider.getBalance()).toBe(100_000 - 98_000);
    // Defence in depth: the bank's own limit still refuses a single over-limit transfer (what a bug or a stale cap would produce).
    const ben = await provider.registerUpiBeneficiary(m.vpa);
    await expect(provider.createPayout({ referenceId: 'direct', amountMinor: 60_000, currency: 'INR', destinationRef: ben.ref, idempotencyKey: 'direct' })).rejects.toMatchObject({ code: 'UPI_LIMIT_EXCEEDED' });
  });

  it('a definitive bank refusal fails the payout and releases the funds (here: the beneficiary is no longer known to the bank)', async () => {
    const m = await merchant();
    await customerPays((await payRequest(m, 100_000)).provider_order_id);
    (provider as any).beneficiaries.clear(); // the bank forgot the registered beneficiary
    const po = await p.payouts.request(m.id, { idempotencyKey: 'refused' }, m.actor);
    await p.jobs.drain(p.handlers);
    const [row] = await db.query<any>('SELECT status, failure_reason FROM payouts WHERE id=$1', [po.id]);
    expect(row.status).toBe('FAILED');
    expect(row.failure_reason).toBe('PROVIDER_REJECTED:UNKNOWN_BENEFICIARY');
    expect(await payable(m.id)).toBe(98_000); // reservation released
    expect(await provider.getBalance()).toBe(100_000); // nothing left the account
  });

  it('waits (QUEUED, alert, nothing sent) when the owner account does not hold the money, then pays after a top-up', async () => {
    const m = await merchant();
    await customerPays((await payRequest(m, 100_000)).provider_order_id);
    provider.topUp(-60_000); // the owner spent part of it elsewhere: balance 40,000 < 98,000
    const po = await p.payouts.request(m.id, { idempotencyKey: 'low-balance' }, m.actor);
    await p.jobs.drain(p.handlers);
    await p.jobs.drain(p.handlers, later());
    const [row] = await db.query<any>('SELECT status, outcome_unknown FROM payouts WHERE id=$1', [po.id]);
    expect(row).toMatchObject({ status: 'QUEUED', outcome_unknown: false }); // honest state: never sent
    expect(provider.payoutCreateCalls).toBe(0);
    expect((await db.query('SELECT 1 FROM alerts WHERE kind=$1', ['PROVIDER_BALANCE_LOW'])).length).toBe(1); // one alert, not one per retry
    provider.topUp(60_000);
    await p.jobs.drain(p.handlers, new Date(Date.now() + 90 * 24 * 3600 * 1000));
    expect((await db.query<any>('SELECT status FROM payouts WHERE id=$1', [po.id]))[0].status).toBe('SUCCEEDED');
    expect(provider.payoutCreateCalls).toBe(1);
  });

  it('an ambiguous UPI payout (timeout after the bank accepted it) is never paid twice', async () => {
    const m = await merchant();
    await customerPays((await payRequest(m, 100_000)).provider_order_id);
    provider.payoutBehavior = 'timeout_after_accept';
    const po = await p.payouts.request(m.id, { idempotencyKey: 'ambiguous' }, m.actor);
    await p.jobs.drain(p.handlers);
    expect((await db.query<any>('SELECT status FROM payouts WHERE id=$1', [po.id]))[0].status).toBe('SUBMITTED');
    await p.jobs.drain(p.handlers, later());
    expect((await db.query<any>('SELECT status FROM payouts WHERE id=$1', [po.id]))[0].status).toBe('SUCCEEDED');
    expect(await provider.getBalance()).toBe(100_000 - 98_000); // debited once
    expect(provider.payoutCreateCalls).toBe(1);
  });
});

describe('merchant UPI ID registration', () => {
  it('stores only the bank token, the masked UPI ID and the bank-returned name; the raw UPI ID appears nowhere', async () => {
    const raw = 'rahul.traders@okhdfc';
    const m = await merchant(raw);
    const [d] = await db.query<any>('SELECT * FROM merchant_settlement_destinations WHERE id=$1', [m.destId]);
    expect(d).toMatchObject({ beneficiary_kind: 'UPI', masked_account: maskVpa(raw), beneficiary_name: 'TEST TRADERS', status: 'VERIFIED' });
    expect(d.masked_account).toBe('ra****@okhdfc');
    expect(d.provider_destination_ref).toMatch(/^ben_sbx_/);
    const dump = JSON.stringify([
      await db.query('SELECT * FROM merchant_settlement_destinations'),
      await db.query('SELECT * FROM audit_logs'),
      await db.query('SELECT * FROM alerts'),
      await db.query('SELECT * FROM payouts'),
      await db.query('SELECT * FROM risk_reviews'),
    ]);
    expect(dump.includes('rahul.traders')).toBe(false);
  });

  it('rejects malformed and non-existent UPI IDs, and providers without UPI support', async () => {
    const reg = await p.merchants.register({ email: 'x@example.test', passwordHash: 'x', legalName: 'Some Co Pvt Ltd', displayName: 'Some' });
    const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
    await expect(p.merchants.addUpiDestination(reg.merchantId, 'not-a-upi-id', actor)).rejects.toMatchObject({ code: 'INVALID_VPA' });
    await expect(p.merchants.addUpiDestination(reg.merchantId, 'ghost@invalid', actor)).rejects.toMatchObject({ code: 'VPA_NOT_FOUND', status: 422 });
    await expect(p.merchants.addUpiDestination(reg.merchantId, 'a b@okhdfc', actor)).rejects.toMatchObject({ code: 'INVALID_VPA' });
    const plain = createPlatform(db, new SandboxProvider(WEBHOOK_SECRET), testSecurity(() => new Date()));
    await expect(plain.merchants.addUpiDestination(reg.merchantId, 'ok.name@okhdfc', actor)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(await db.query('SELECT 1 FROM merchant_settlement_destinations')).toHaveLength(0);
  });

  it('an administrator must confirm when the bank name does not match the merchant legal name', async () => {
    const reg = await p.merchants.register({ email: 'y@example.test', passwordHash: 'x', legalName: 'Test Traders Pvt Ltd', displayName: 'Test Traders' });
    await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin);
    const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
    provider.setVpaHolder('someone.else@oksbi', 'RAMESH KUMAR');
    const d = await p.merchants.addUpiDestination(reg.merchantId, 'someone.else@oksbi', actor);
    await expect(p.merchants.verifyDestination(d.id, admin)).rejects.toMatchObject({ code: 'NAME_MISMATCH' });
    await p.merchants.verifyDestination(d.id, admin, { confirmReview: true });
    const logged = (await db.query<any>(`SELECT detail FROM audit_logs WHERE action='destination.verified'`)).pop();
    expect(logged.detail.acceptedNameMismatch).toBe(true); // the override itself is on record
  });

  it('flags the same UPI ID used by two merchants, and refuses to verify it without explicit confirmation', async () => {
    await merchant('shared.account@okhdfc');
    const reg = await p.merchants.register({ email: 'z@example.test', passwordHash: 'x', legalName: 'Test Traders Pvt Ltd', displayName: 'Test Traders 2' });
    await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin);
    provider.setVpaHolder('shared.account@okhdfc', 'TEST TRADERS');
    const d = await p.merchants.addUpiDestination(reg.merchantId, 'shared.account@okhdfc', { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId });
    expect(d.duplicateFlagged).toBe(true);
    await expect(p.merchants.verifyDestination(d.id, admin)).rejects.toMatchObject({ code: 'OPEN_RISK_REVIEW' });
    await p.merchants.verifyDestination(d.id, admin, { confirmReview: true });
  });

  it('a payout cannot use a destination that is not verified', async () => {
    const reg = await p.merchants.register({ email: 'w@example.test', passwordHash: 'x', legalName: 'Test Traders Pvt Ltd', displayName: 'T' });
    await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin);
    const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
    await customerPays((await payRequest({ id: reg.merchantId, actor })).provider_order_id);
    await p.merchants.addUpiDestination(reg.merchantId, 'pending.dest@okhdfc', actor); // PENDING, never verified
    await expect(p.payouts.request(reg.merchantId, { idempotencyKey: 'x' }, actor)).rejects.toMatchObject({ code: 'NO_VERIFIED_DESTINATION' });
  });
});

describe('HTTP', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  beforeEach(async () => {
    app = await createApp({ platform: p, jwtSecret: 'j'.repeat(40), rateLimits: { auth: 1000, mfa: 1000, recovery: 1000, global: 10000 } });
    await app.init();
    http = request(app.getHttpServer());
  });
  afterEach(async () => app.close());

  it('merchant registers a UPI ID over the API (masked in the response); sandbox checkout page simulates the bank credit through the real webhook path', async () => {
    const pw = 'correct-horse-battery';
    const reg = await http.post('/auth/register').send({ email: 'api@example.test', password: pw, legalName: 'Test Traders Pvt Ltd', displayName: 'Test Traders' }).expect(201);
    const [c] = await db.query<any>('SELECT id FROM merchant_verification_cases WHERE merchant_id=$1', [reg.body.merchantId]);
    await p.merchants.decideVerification(c.id, 'APPROVED', admin);
    const token = (await http.post('/auth/login').send({ email: 'api@example.test', password: pw }).expect(201)).body.token;
    const auth = { Authorization: `Bearer ${token}` };

    await http.post('/merchant/destinations/upi').set(auth).send({ vpa: 'bad' }).expect(400);
    await http.post('/merchant/destinations/upi').set(auth).send({ vpa: 'ghost@invalid' }).expect(422);
    const d = await http.post('/merchant/destinations/upi').set(auth).send({ vpa: 'api.shop@okhdfc' }).expect(201);
    expect(d.body).toMatchObject({ maskedVpa: 'ap****@okhdfc', status: 'PENDING' });
    expect(JSON.stringify(d.body)).not.toContain('api.shop');
    const me = (await http.get('/merchant/me').set(auth).expect(200)).body;
    expect(JSON.stringify(me)).not.toContain('api.shop');
    await p.merchants.verifyDestination(d.body.id, admin, { confirmReview: true });

    const r = await http.post('/merchant/payment-requests').set(auth).send({ orderReference: 'API-1', amountMinor: 25_000 }).expect(201);
    expect(r.body.sandbox).toBe(true);
    const ref = r.body.checkoutUrl.split('/').pop();
    await http.post(`/sandbox/pay/${ref}`).send({ outcome: 'failed' }).expect(201); // no credit at a bank for a failed attempt
    await p.jobs.drain(p.handlers);
    expect((await http.get('/merchant/balance').set(auth)).body.payableMinor).toBe(0);
    await http.post(`/sandbox/pay/${ref}`).send({}).expect(201);
    await p.jobs.drain(p.handlers);
    expect((await http.get('/merchant/balance').set(auth)).body.payableMinor).toBe(24_500);
    const pub = (await http.get(`/public/pay/${r.body.publicToken}`).expect(200)).body;
    expect(pub.status).toBe('PAID');
  });
});
