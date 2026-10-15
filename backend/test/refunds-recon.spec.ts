import { ACCOUNTS } from '../src/ledger/ledger.service';
import { collect, createRequest, Ctx, farFuture, payableOf, seedMerchant, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.db.close();
});

describe('refunds', () => {
  it('10. a refund posts compensating entries, refunds fee pro rata and tracks status', async () => {
    const m = await seedMerchant(ctx);
    const { payment } = await collect(ctx, m, 100_000); // fee 2,000, payable 98,000
    const r1 = await ctx.p.refunds.request(payment.id, { amountMinor: 25_000, idempotencyKey: 'r1' }, ctx.admin);
    expect(r1.status).toBe('SUCCEEDED');
    expect(r1.fee_refund_minor).toBe(500);
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000 - 24_500);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.FEE_REVENUE.code)).toBe(1500);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(75_000);
    let [p] = await ctx.db.query<any>('SELECT status, refunded_minor FROM payments WHERE id=$1', [payment.id]);
    expect(p).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunded_minor: 25_000 });

    await ctx.p.refunds.request(payment.id, { amountMinor: 75_000, idempotencyKey: 'r2' }, ctx.admin);
    [p] = await ctx.db.query<any>('SELECT status, refunded_minor FROM payments WHERE id=$1', [payment.id]);
    expect(p).toMatchObject({ status: 'REFUNDED', refunded_minor: 100_000 });
    expect(await payableOf(ctx, m.merchantId)).toBe(0);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.FEE_REVENUE.code)).toBe(0);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(0);
    expect(await ctx.p.ledger.findUnbalancedJournals(ctx.db)).toHaveLength(0);
    // Original collection journal untouched; only new journals were added.
    expect((await ctx.db.query('SELECT 1 FROM ledger_journals WHERE kind=$1', ['COLLECTION'])).length).toBe(1);
  });

  it('rejects over-refunds and treats a repeated idempotency key as the same refund', async () => {
    const m = await seedMerchant(ctx);
    const { payment } = await collect(ctx, m, 100_000);
    await expect(ctx.p.refunds.request(payment.id, { amountMinor: 100_001, idempotencyKey: 'x' }, ctx.admin)).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT' });
    const a = await ctx.p.refunds.request(payment.id, { amountMinor: 40_000, idempotencyKey: 'same' }, ctx.admin);
    const b = await ctx.p.refunds.request(payment.id, { amountMinor: 40_000, idempotencyKey: 'same' }, ctx.admin);
    expect(a.id).toBe(b.id);
    await expect(ctx.p.refunds.request(payment.id, { amountMinor: 50_000, idempotencyKey: 'same' }, ctx.admin)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const [p] = await ctx.db.query<any>('SELECT refunded_minor FROM payments WHERE id=$1', [payment.id]);
    expect(p.refunded_minor).toBe(40_000);
  });

  it('stays pending through a provider outage and completes exactly once afterwards', async () => {
    const m = await seedMerchant(ctx);
    const { payment } = await collect(ctx, m, 100_000);
    ctx.provider.outage = false;
    const orig = ctx.provider.createRefund.bind(ctx.provider);
    let fail = true;
    ctx.provider.createRefund = async (i) => {
      if (fail) {
        const { TransientError } = await import('../src/common/errors');
        throw new TransientError('timeout');
      }
      return orig(i);
    };
    const r = await ctx.p.refunds.request(payment.id, { amountMinor: 10_000, idempotencyKey: 'k' }, ctx.admin);
    expect(r.status).toBe('PENDING');
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(100_000);
    fail = false;
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture());
    const [after] = await ctx.db.query<any>('SELECT status FROM refunds WHERE id=$1', [r.id]);
    expect(after.status).toBe('SUCCEEDED');
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(90_000);
  });

  it('refunds a payment held in suspense in full, from suspense', async () => {
    const m = await seedMerchant(ctx);
    const req = await createRequest(ctx, m, 100_000);
    const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id, { amountMinor: 90_000 });
    const res = await ctx.p.verification.applyProviderPayment(sim.payment);
    await expect(ctx.p.refunds.request(res.paymentId, { amountMinor: 1000, idempotencyKey: 'p' }, ctx.admin)).rejects.toMatchObject({ code: 'FULL_REFUND_ONLY' });
    await ctx.p.refunds.request(res.paymentId, { amountMinor: 90_000, idempotencyKey: 'f' }, ctx.admin);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.SUSPENSE.code)).toBe(0);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(0);
  });
});

describe('reconciliation', () => {
  it('13. is clean after normal activity', async () => {
    const m = await seedMerchant(ctx);
    const { payment } = await collect(ctx, m, 100_000);
    await ctx.p.refunds.request(payment.id, { amountMinor: 10_000, idempotencyKey: 'r' }, ctx.admin);
    await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'p' }, m.actor);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const run = await ctx.p.reconciliation.run();
    expect(run.items).toEqual([]);
    expect(run.discrepancies).toBe(0);
  });

  it('13b. detects missing, orphaned and inconsistent records', async () => {
    const m = await seedMerchant(ctx);
    const { sim } = await collect(ctx, m, 100_000);
    // Provider captured money we never heard about.
    ctx.provider.injectOrphanPayment({ id: 'pay_sbx_ghost', orderId: 'order_x', amountMinor: 7_000, currency: 'INR', status: 'captured', merchantRef: m.merchantId, refundedMinor: 0 });
    // Provider says a payment we credited has been refunded behind our back.
    sim.payment.refundedMinor = 5_000;
    await ctx.db.query(`INSERT INTO payments(provider, provider_payment_id, amount_minor, currency, status, merchant_id) VALUES ('sandbox','pay_not_at_provider',500,'INR','SUCCEEDED',$1)`, [m.merchantId]);
    const run = await ctx.p.reconciliation.run();
    const kinds = run.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['MISSING_INTERNAL_PAYMENT', 'REFUND_MISMATCH', 'MISSING_AT_PROVIDER', 'MISSING_LEDGER_ENTRY', 'PROVIDER_CLEARING_MISMATCH']));
    expect(run.discrepancies).toBeGreaterThan(0);
    expect((await ctx.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['RECONCILIATION_DISCREPANCY'])).length).toBe(1);
  });

  it('flags a provider payout we have no record of', async () => {
    await ctx.provider.createPayout({ referenceId: 'unknown-ref', amountMinor: 1000, currency: 'INR', destinationRef: 'fa', idempotencyKey: 'z' });
    const run = await ctx.p.reconciliation.run();
    expect(run.items.map((i) => i.kind)).toContain('ORPHAN_PROVIDER_PAYOUT');
  });
});
