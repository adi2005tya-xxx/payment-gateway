import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/auth';
import { Ctx, setup } from './helpers';

let ctx: Ctx;
let app: INestApplication;
let http: ReturnType<typeof request>;
const PW = 'correct-horse-battery';

beforeAll(async () => {
  ctx = await setup();
  app = await createApp({ platform: ctx.p, jwtSecret: 'j'.repeat(40) });
  await app.init();
  http = request(app.getHttpServer());
  await ctx.db.query(`INSERT INTO users(email, password_hash, role) VALUES ('boss@example.test',$1,'ADMIN')`, [await hashPassword(PW)]);
});
afterAll(async () => {
  await app.close();
  await ctx.db.close();
});

const adminSecrets = new Map<string, string>();
/** Logs in; admins complete real MFA (enrol on first use, TOTP challenge afterwards). */
const login = async (email: string) => {
  const r = await http.post('/auth/login').send({ email, password: PW }).expect(201);
  if (r.body.mfa === 'NOT_REQUIRED') return r.body.token as string;
  if (r.body.mfa === 'ENROL_REQUIRED') {
    const st = await http.post('/auth/mfa/enrol/start').set(auth(r.body.token)).expect(201);
    adminSecrets.set(email, st.body.secret);
    const c = await http.post('/auth/mfa/enrol/confirm').set(auth(r.body.token)).send({ code: ctx.freshCode(st.body.secret) }).expect(201);
    return c.body.token as string;
  }
  const c = await http.post('/auth/mfa/challenge').set(auth(r.body.token)).send({ code: ctx.freshCode(adminSecrets.get(email)!) }).expect(201);
  return c.body.token as string;
};
/** Admin token with a fresh step-up, for high-risk operations. */
const stepUp = async (token: string, email: string) => {
  await http.post('/auth/mfa/step-up').set(auth(token)).send({ code: ctx.freshCode(adminSecrets.get(email)!) }).expect(201);
  return token;
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function onboard(email: string, name: string) {
  const reg = await http.post('/auth/register').send({ email, password: PW, legalName: name + ' Pvt Ltd', displayName: name });
  expect(reg.status).toBe(201);
  const admin = await login('boss@example.test');
  await stepUp(admin, 'boss@example.test');
  const cases = (await http.get('/admin/verification-cases').set(auth(admin))).body;
  const c = cases.find((x: any) => x.merchant_id === reg.body.merchantId);
  await http.post(`/admin/verification-cases/${c.id}/decision`).set(auth(admin)).send({ decision: 'APPROVED' }).expect(201);
  const token = await login(email);
  const d = await http.post('/merchant/destinations').set(auth(token)).send({ label: 'HDFC', providerDestinationRef: 'fa_sbx_1', maskedAccount: 'XXXX4321' }).expect(201);
  await http.post(`/admin/destinations/${d.body.id}/verify`).set(auth(admin)).expect(201);
  return { token, admin, merchantId: reg.body.merchantId as string };
}

describe('HTTP API', () => {
  let a: Awaited<ReturnType<typeof onboard>>;
  let b: Awaited<ReturnType<typeof onboard>>;
  beforeAll(async () => {
    a = await onboard('a@example.test', 'Alpha');
    b = await onboard('b@example.test', 'Bravo');
  });

  it('requires authentication and the right role', async () => {
    await http.get('/merchant/me').expect(401);
    await http.get('/merchant/me').set(auth('garbage')).expect(401);
    await http.get('/admin/merchants').set(auth(a.token)).expect(403);
    await http.get('/merchant/me').set(auth(a.admin)).expect(403);
  });

  it('rejects weak passwords and wrong credentials identically for unknown users', async () => {
    await http.post('/auth/register').send({ email: 'w@example.test', password: 'short', legalName: 'Weak Co', displayName: 'Weak' }).expect(400);
    const r1 = await http.post('/auth/login').send({ email: 'nobody@example.test', password: PW });
    const r2 = await http.post('/auth/login').send({ email: 'a@example.test', password: 'wrong-password-123' });
    expect(r1.status).toBe(401);
    expect(r1.body).toEqual(r2.body);
  });

  it('14. one merchant cannot read or change another merchant\'s data', async () => {
    const reqA = await http.post('/merchant/payment-requests').set(auth(a.token)).send({ orderReference: 'A-1', amountMinor: 100_000 }).expect(201);
    expect(reqA.body.sandbox).toBe(true);
    // Pay it through the sandbox checkout -> signed webhook -> worker.
    const orderId = reqA.body.checkoutUrl.split('/').pop();
    await http.post(`/sandbox/pay/${orderId}`).send({ outcome: 'captured' }).expect(201);
    await ctx.p.jobs.drain(ctx.p.handlers);

    const paymentsA = (await http.get('/merchant/payments').set(auth(a.token)).expect(200)).body;
    expect(paymentsA).toHaveLength(1);
    expect(paymentsA[0].status).toBe('SUCCEEDED');
    expect((await http.get('/merchant/payments').set(auth(b.token)).expect(200)).body).toHaveLength(0);
    await http.get(`/merchant/payments/${paymentsA[0].id}`).set(auth(b.token)).expect(404);
    await http.post(`/merchant/payment-requests/${reqA.body.id}/cancel`).set(auth(b.token)).expect(404);
    expect((await http.get('/merchant/payment-requests').set(auth(b.token))).body).toHaveLength(0);
    expect((await http.get('/merchant/balance').set(auth(b.token))).body.availableMinor).toBe(0);
    const csvB = await http.get('/merchant/payments.csv').set(auth(b.token)).expect(200);
    expect(csvB.text).not.toContain('A-1');
  });

  it('webhook endpoint: forged -> 401, genuine -> 201, replay -> acknowledged as duplicate', async () => {
    const reqB = await http.post('/merchant/payment-requests').set(auth(b.token)).send({ orderReference: 'B-1', amountMinor: 50_000 }).expect(201);
    const sim = ctx.provider.simulateCustomerPayment(reqB.body.checkoutUrl.split('/').pop());
    await http.post('/webhooks/sandbox').set('x-gateway-signature', 'bad').set('content-type', 'application/json').send(sim.webhook.body).expect(401);
    const ok = await http.post('/webhooks/sandbox').set('x-gateway-signature', sim.webhook.signature).set('content-type', 'application/json').send(sim.webhook.body).expect(201);
    expect(ok.body.duplicate).toBe(false);
    const again = await http.post('/webhooks/sandbox').set('x-gateway-signature', sim.webhook.signature).set('content-type', 'application/json').send(sim.webhook.body).expect(201);
    expect(again.body.duplicate).toBe(true);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect((await http.get('/merchant/balance').set(auth(b.token))).body.payableMinor).toBe(49_000);
  });

  it('payout needs an idempotency key and is replay-safe over HTTP', async () => {
    await http.post('/merchant/payouts').set(auth(a.token)).send({}).expect(400);
    const first = await http.post('/merchant/payouts').set(auth(a.token)).set('Idempotency-Key', 'payout-key-0001').send({}).expect(201);
    const second = await http.post('/merchant/payouts').set(auth(a.token)).set('Idempotency-Key', 'payout-key-0001').send({}).expect(201);
    expect(second.body.id).toBe(first.body.id);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const list = (await http.get('/merchant/payouts').set(auth(a.token))).body;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('SUCCEEDED');
  });

  it('public payment link exposes only customer-safe fields', async () => {
    const r = await http.post('/merchant/payment-requests').set(auth(a.token)).send({ orderReference: 'A-2', amountMinor: 12_300, description: 'Consulting' }).expect(201);
    const view = (await http.get(`/public/pay/${r.body.publicToken}`).expect(200)).body;
    expect(Object.keys(view).sort()).toEqual(['amountMinor', 'currency', 'description', 'expiresAt', 'merchantName', 'qrImage', 'sandbox', 'sandboxOrderId', 'status']);
    expect(view.status).toBe('AWAITING_PAYMENT');
    expect(view.qrImage).toMatch(/^data:image\/png;base64,/);
  });

  it('15. admin payout controls are enforced server-side with an audit record', async () => {
    await ctx.db.query(`UPDATE merchants SET review_threshold_minor=1000 WHERE id=$1`, [a.merchantId]);
    const r = await http.post('/merchant/payment-requests').set(auth(a.token)).send({ orderReference: 'A-3', amountMinor: 200_000 }).expect(201);
    await http.post(`/sandbox/pay/${r.body.checkoutUrl.split('/').pop()}`).send({}).expect(201);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const po = (await http.post('/merchant/payouts').set(auth(a.token)).set('Idempotency-Key', 'payout-key-0002').send({}).expect(201)).body;
    expect(po.status).toBe('UNDER_REVIEW');
    await http.post(`/admin/payouts/${po.id}/approve`).set(auth(a.token)).expect(403); // merchants cannot approve
    await stepUp(a.admin, 'boss@example.test');
    await http.post(`/admin/payouts/${po.id}/approve`).set(auth(a.admin)).expect(201);
    const logs = (await http.get('/admin/audit-logs').set(auth(a.admin))).body.map((l: any) => l.action);
    expect(logs).toContain('payout.approved');
  });

  it('admin health reports a valid audit chain and no unbalanced journals', async () => {
    const h = (await http.get('/admin/health').set(auth(a.admin)).expect(200)).body;
    expect(h).toMatchObject({ unbalancedJournals: 0, auditChainValid: true, sandbox: true });
  });
});
