import { randomBytes, randomUUID } from 'crypto';
import { SecurityOptions } from '../auth/auth.service';
import { Actor } from '../audit/audit.service';
import { TransientError } from '../common/errors';
import { Platform } from '../platform';
import { SandboxProvider } from '../provider/sandbox.provider';

/** Security options for drills/tests (random key, default clock). */
export const drillSecurity = (): SecurityOptions => ({
  mfaKey: randomBytes(32),
  issuer: 'GatewayDrill',
  stepUpWindowSeconds: 300,
  recoveryDelayHours: 24,
  requiredRoles: ['ADMIN'],
  sessionTtlMinutes: 60,
  maxMfaAttempts: 5,
  mfaLockMinutes: 15,
  maxLoginAttempts: 5,
  loginLockMinutes: 15,
});

export interface SeedResult {
  admin: Actor;
  admin2: Actor;
  merchants: { A: string; B: string; C: string };
  payouts: { aSucceeded: string; aFailed: string; bProcessing: string; bAmbiguous: string; cHeld: string; queued: string };
  payments: { underReview: string; refundedFully: string; partiallyRefunded: string };
  pendingRefundId: string;
  unprocessedWebhookEventId: string;
}

/**
 * SYNTHETIC data only. Builds a representative financial state through the real services, deliberately leaving work in flight:
 * queued/processing/ambiguous payouts, a held payout, a pending refund, an unprocessed webhook with a queued job,
 * a payment under review, unpaid requests, idempotency records and unresolved reconciliation items.
 */
export async function seedRepresentativeData(p: Platform, provider: SandboxProvider): Promise<SeedResult> {
  const db = p.db;
  const mkAdmin = async (email: string): Promise<Actor> => {
    const [u] = await db.query<{ id: string }>(`INSERT INTO users(email, password_hash, role) VALUES ($1,'x','ADMIN') RETURNING id`, [email]);
    return { id: u.id, role: 'ADMIN' };
  };
  const admin = await mkAdmin('dr-admin-1@example.test');
  const admin2 = await mkAdmin('dr-admin-2@example.test');

  const mkMerchant = async (name: string, reviewThreshold = 5_000_000) => {
    const reg = await p.merchants.register({ email: `dr-${name.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`, passwordHash: 'x', legalName: `${name} Synthetic Pvt Ltd`, displayName: `${name} Synthetic` });
    await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin);
    const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
    const d = await p.merchants.addDestination(reg.merchantId, { label: 'Main', providerDestinationRef: `fa_sbx_${randomUUID().slice(0, 8)}`, maskedAccount: 'XXXX0001' }, actor);
    await p.merchants.verifyDestination(d, admin);
    await db.query('UPDATE merchants SET review_threshold_minor=$2 WHERE id=$1', [reg.merchantId, reviewThreshold]);
    return { id: reg.merchantId, actor };
  };
  const collect = async (m: { id: string; actor: Actor }, amount: number, opts: { amountMinor?: number } = {}) => {
    const req = await p.requests.create(m.id, { orderReference: `SYN-${randomUUID().slice(0, 8)}`, amountMinor: amount }, m.actor);
    const sim = provider.simulateCustomerPayment(req.provider_order_id, opts);
    await p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    await p.jobs.drain(p.handlers);
    const [pay] = await db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
    return { req, sim, pay };
  };

  const A = await mkMerchant('A');
  const B = await mkMerchant('B');
  const C = await mkMerchant('C', 50_000);

  // ---- Merchant A: completed history incl. refunds and payouts (success + failure)
  const a1 = await collect(A, 100_000);
  const a2 = await collect(A, 250_000);
  const a3 = await collect(A, 40_000);
  await p.refunds.request(a1.pay.id, { amountMinor: 25_000, idempotencyKey: 'syn-refund-a1-partial' }, admin);
  await p.refunds.request(a3.pay.id, { amountMinor: 40_000, idempotencyKey: 'syn-refund-a3-full' }, admin);
  const aOk = await p.payouts.request(A.id, { amountMinor: 50_000, idempotencyKey: 'syn-payout-a-ok' }, A.actor);
  await p.jobs.drain(p.handlers);
  provider.payoutBehavior = 'fail';
  const aFail = await p.payouts.request(A.id, { amountMinor: 20_000, idempotencyKey: 'syn-payout-a-fail' }, A.actor);
  await p.jobs.drain(p.handlers);
  provider.payoutBehavior = 'success';
  void a2;

  // ---- Idempotency records (synthetic) and unresolved reconciliation items
  await db.query(`INSERT INTO idempotency_records(scope, key, request_hash, response) VALUES ('syn:payout','syn-key-1','h1','{"ok":true}'), ('syn:refund','syn-key-2','h2','{"ok":true}')`);
  provider.injectOrphanPayment({ id: 'pay_sbx_syn_orphan', orderId: 'order_syn_unknown', amountMinor: 7_000, currency: 'INR', status: 'captured', merchantRef: 'unknown', refundedMinor: 0 });
  await p.reconciliation.run(); // leaves unresolved items on record (run before B so in-flight payouts below stay in flight)

  // ---- Merchant B: one payout still PROCESSING at the provider, one with an AMBIGUOUS outcome (timeout after provider accepted)
  await collect(B, 300_000);
  await collect(B, 120_000);
  provider.payoutBehavior = 'processing';
  const bProc = await p.payouts.request(B.id, { amountMinor: 100_000, idempotencyKey: 'syn-payout-b-processing' }, B.actor);
  await p.jobs.drain(p.handlers);
  provider.payoutBehavior = 'timeout_after_accept';
  const bAmb = await p.payouts.request(B.id, { amountMinor: 50_000, idempotencyKey: 'syn-payout-b-ambiguous' }, B.actor);
  await p.jobs.drain(p.handlers);
  provider.payoutBehavior = 'success';
  // Their retries are scheduled for later; pin them so the in-flight state is deterministic (not dependent on wall-clock).
  await db.query(`UPDATE jobs SET run_at = now() + interval '1 hour' WHERE kind='advance_payout' AND status='PENDING'`);

  // ---- Merchant C: payment under review, held payout (dual control), pending refund (provider unreachable)
  const cReview = await collect(C, 100_000, { amountMinor: 90_000 });
  const cOk = await collect(C, 80_000);
  const cHeld = await p.payouts.request(C.id, { amountMinor: 60_000, idempotencyKey: 'syn-payout-c-held' }, C.actor);
  const origRefund = provider.createRefund.bind(provider);
  provider.createRefund = async () => {
    throw new TransientError('simulated provider timeout');
  };
  const pendingRefund = await p.refunds.request(cOk.pay.id, { amountMinor: 10_000, idempotencyKey: 'syn-refund-c-pending' }, admin);
  provider.createRefund = origRefund;

  // ---- A payout that is QUEUED but whose job has not run yet (in-flight at backup time)
  const queued = await p.payouts.request(A.id, { amountMinor: 10_000, idempotencyKey: 'syn-payout-a-queued' }, A.actor);

  // ---- Unpaid request, duplicate webhook delivery, and an UNPROCESSED webhook (stored + job queued, not yet applied)
  await p.requests.create(A.id, { orderReference: 'SYN-UNPAID', amountMinor: 5_000 }, A.actor);
  await p.verification.ingestWebhook(a1.sim.webhook.body, a1.sim.webhook.signature); // duplicate of an applied event
  const pendingReq = await p.requests.create(B.id, { orderReference: 'SYN-INFLIGHT-WEBHOOK', amountMinor: 70_000 }, B.actor);
  const simPending = provider.simulateCustomerPayment(pendingReq.provider_order_id);
  await p.verification.ingestWebhook(simPending.webhook.body, simPending.webhook.signature);
  const [ev] = await db.query<any>(`SELECT id FROM webhook_events WHERE provider_event_id=$1`, [simPending.webhook.eventId]);

  return {
    admin,
    admin2,
    merchants: { A: A.id, B: B.id, C: C.id },
    payouts: { aSucceeded: aOk.id, aFailed: aFail.id, bProcessing: bProc.id, bAmbiguous: bAmb.id, cHeld: cHeld.id, queued: queued.id },
    payments: { underReview: cReview.pay.id, refundedFully: a3.pay.id, partiallyRefunded: a1.pay.id },
    pendingRefundId: pendingRefund.id,
    unprocessedWebhookEventId: ev.id,
  };
}
