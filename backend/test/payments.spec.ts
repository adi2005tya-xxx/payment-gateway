import { ACCOUNTS, merchantPayable } from '../src/ledger/ledger.service';
import { collect, createRequest, Ctx, farFuture, payableOf, seedMerchant, setup } from './helpers';
import { createPlatform } from '../src/platform';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.db.close();
});

const journalCount = async (kind: string) =>
  Number((await ctx.db.query<any>('SELECT COUNT(*) AS n FROM ledger_journals WHERE kind=$1', [kind]))[0].n);

describe('payment verification', () => {
  it('1. verifies a successful payment and records it in the ledger', async () => {
    const m = await seedMerchant(ctx);
    const { req, payment } = await collect(ctx, m, 100_000); // Rs 1,000 at 2% fee
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.fee_minor).toBe(2000);
    expect(payment.net_minor).toBe(98_000);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.FEE_REVENUE.code)).toBe(2000);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(100_000);
    const [r] = await ctx.db.query<any>('SELECT status FROM payment_requests WHERE id=$1', [req.id]);
    expect(r.status).toBe('PAID');
    expect(payment.is_sandbox).toBe(true);
  });

  it('2. rejects a forged webhook and stores nothing', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 50_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id);
    await expect(ctx.p.verification.ingestWebhook(sim.webhook.body, 'deadbeef')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', status: 401 });
    await expect(ctx.p.verification.ingestWebhook(sim.webhook.body + ' ', sim.webhook.signature)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(ctx.p.verification.ingestWebhook(sim.webhook.body, undefined)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(await ctx.db.query('SELECT 1 FROM webhook_events')).toHaveLength(0);
    expect((await ctx.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['WEBHOOK_SIGNATURE_FAILURE'])).length).toBe(3);
    expect(await payableOf(ctx, m.merchantId)).toBe(0);
  });

  it('3. a duplicate webhook (same or new event id) never duplicates ledger entries', async () => {
    const m = await seedMerchant(ctx);
    const { sim } = await collect(ctx, m, 100_000);
    const again = await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    expect(again.duplicate).toBe(true);
    // Provider re-sends the same payment under a different event id.
    const resend = ctx.provider.signedWebhook('payment.captured', sim.payment);
    await ctx.p.verification.ingestWebhook(resend.body, resend.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect(await journalCount('COLLECTION')).toBe(1);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('4. a mismatched amount is held in suspense, not credited', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id, { amountMinor: 90_000 });
    await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const [p] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
    expect(p.status).toBe('UNDER_REVIEW');
    expect(p.verification_result).toContain('AMOUNT_MISMATCH');
    expect(await payableOf(ctx, m.merchantId)).toBe(0);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.SUSPENSE.code)).toBe(90_000);
    expect((await ctx.db.query('SELECT 1 FROM risk_reviews WHERE status=$1', ['OPEN'])).length).toBe(1);
  });

  it('5. a payment for one merchant cannot be credited to another', async () => {
    const a = await seedMerchant(ctx, { name: 'Merchant A' });
    const b = await seedMerchant(ctx, { name: 'Merchant B' });
    const req = await createRequest(ctx, a, 100_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id, { merchantRef: b.merchantId });
    await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const [p] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
    expect(p.status).toBe('UNDER_REVIEW');
    expect(p.verification_result).toContain('MERCHANT_MISMATCH');
    expect(await payableOf(ctx, a.merchantId)).toBe(0);
    expect(await payableOf(ctx, b.merchantId)).toBe(0);
  });

  it('6. a delayed payment stays pending until the provider confirms it', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id, { outcome: 'pending' });
    const wh = ctx.provider.signedWebhook('payment.captured', sim.payment); // webhook claims capture; provider still says pending
    await ctx.p.verification.ingestWebhook(wh.body, wh.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect(await payableOf(ctx, m.merchantId)).toBe(0);
    const [r1] = await ctx.db.query<any>('SELECT status FROM payment_requests WHERE id=$1', [req.id]);
    expect(r1.status).toBe('PENDING');

    ctx.provider.setPaymentStatus(sim.payment.id, 'captured');
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture());
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('7. a provider API timeout does not mark the payment failed, and recovers', async () => {
    const m = await seedMerchant(ctx);
    const { req, sim } = await (async () => {
      const req = await createRequest(ctx, m, 100_000);
      const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id);
      return { req, sim };
    })();
    ctx.provider.outage = true;
    await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect(await ctx.db.query('SELECT 1 FROM payments')).toHaveLength(0);
    const [r] = await ctx.db.query<any>('SELECT status FROM payment_requests WHERE id=$1', [req.id]);
    expect(r.status).toBe('PENDING');
    const [job] = await ctx.db.query<any>(`SELECT status, attempts FROM jobs WHERE kind='process_webhook'`);
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1 });

    ctx.provider.outage = false;
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture());
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('11. concurrent events for the same payment apply exactly once', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id);
    const results = await Promise.all(Array.from({ length: 6 }, () => ctx.p.verification.applyProviderPayment(sim.payment)));
    expect(results.filter((r) => r.outcome === 'SUCCEEDED')).toHaveLength(1);
    expect(await journalCount('COLLECTION')).toBe(1);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('11b. two different payments for one order: the second never credits the merchant', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    const s1 = ctx.provider.simulateCustomerPayment(req.provider_order_id);
    const s2 = ctx.provider.simulateCustomerPayment(req.provider_order_id);
    const results = await Promise.all([ctx.p.verification.applyProviderPayment(s1.payment), ctx.p.verification.applyProviderPayment(s2.payment)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['SUCCEEDED', 'UNDER_REVIEW']);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.SUSPENSE.code)).toBe(100_000);
  });

  it('12. a worker restart does not lose a stored webhook event', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id);
    await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature); // acked, then the "process" dies before any worker runs
    // A worker crashed mid-job: job left RUNNING with an expired lock.
    await ctx.db.query(`UPDATE jobs SET status='RUNNING', attempts=1, locked_until = now() - interval '5 minutes'`);
    const restarted = createPlatform(ctx.db, ctx.provider, ctx.security); // brand-new process, same database
    await restarted.jobs.drain(restarted.handlers);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('a late failure event cannot overwrite a verified payment', async () => {
    const m = await seedMerchant(ctx);
    const { req, sim } = await collect(ctx, m, 100_000);
    const lateFail = { ...sim.payment, id: 'pay_sbx_late_failed', status: 'failed' as const };
    ctx.provider.injectOrphanPayment(lateFail);
    const wh = ctx.provider.signedWebhook('payment.failed', lateFail);
    await ctx.p.verification.ingestWebhook(wh.body, wh.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const [r] = await ctx.db.query<any>('SELECT status FROM payment_requests WHERE id=$1', [req.id]);
    expect(r.status).toBe('PAID');
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('a payment arriving after the request expired is held for review, then releasable by an admin', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    await ctx.db.query(`UPDATE payment_requests SET status='EXPIRED' WHERE id=$1`, [req.id]);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id);
    await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const [p] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
    expect(p.status).toBe('UNDER_REVIEW');
    expect(await payableOf(ctx, m.merchantId)).toBe(0);
    await ctx.p.verification.approveReviewedPayment(p.id, ctx.admin);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.SUSPENSE.code)).toBe(0);
  });

  it('unknown provider orders are never attributed to a merchant', async () => {
    const orphan = { id: 'pay_sbx_orphan', orderId: 'order_unknown', amountMinor: 10_000, currency: 'INR', status: 'captured' as const, merchantRef: 'x', refundedMinor: 0 };
    ctx.provider.injectOrphanPayment(orphan);
    const r = await ctx.p.verification.applyProviderPayment(orphan);
    expect(r).toMatchObject({ outcome: 'UNDER_REVIEW', reasons: ['UNKNOWN_ORDER'] });
  });
});

describe('ledger integrity', () => {
  it('16. every journal balances and the database refuses unbalanced or mutated entries', async () => {
    const m = await seedMerchant(ctx);
    await collect(ctx, m, 100_000);
    await collect(ctx, m, 33_333);
    expect(await ctx.p.ledger.findUnbalancedJournals(ctx.db)).toHaveLength(0);

    // Application guard.
    await expect(
      ctx.db.transaction((tx) =>
        ctx.p.ledger.post(tx, { kind: 'X', refType: 't', refId: '1', lines: [{ account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'D', amountMinor: 5 }, { account: merchantPayable(m.merchantId), dir: 'C', amountMinor: 4 }] }),
      ),
    ).rejects.toMatchObject({ code: 'UNBALANCED_JOURNAL' });

    // Database guard (bypassing the application): unbalanced journal fails at commit.
    await expect(
      ctx.db.transaction(async (tx) => {
        const [j] = await tx.query<any>(`INSERT INTO ledger_journals(kind, ref_type, ref_id, currency) VALUES ('RAW','t','raw','INR') RETURNING id`);
        const [a] = await tx.query<any>(`SELECT id FROM ledger_accounts LIMIT 1`);
        await tx.query(`INSERT INTO ledger_entries(journal_id, account_id, direction, amount_minor) VALUES ($1,$2,'D',100)`, [j.id, a.id]);
      }),
    ).rejects.toThrow(/unbalanced/);

    // Posted entries are immutable.
    await expect(ctx.db.query(`UPDATE ledger_entries SET amount_minor = 1`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM ledger_journals`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('keeps the audit hash chain intact', async () => {
    const m = await seedMerchant(ctx);
    await collect(ctx, m, 100_000);
    expect(await ctx.p.audit.verifyChain(ctx.db)).toBe(true);
  });
});
