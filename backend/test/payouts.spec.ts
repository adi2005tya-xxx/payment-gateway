import { ACCOUNTS } from '../src/ledger/ledger.service';
import { collect, Ctx, farFuture, payableOf, seedMerchant, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.db.close();
});

const payout = async (id: string) => (await ctx.db.query<any>('SELECT * FROM payouts WHERE id=$1', [id]))[0];
const clearing = () => ctx.p.ledger.balance(ctx.db, ACCOUNTS.PAYOUT_CLEARING.code);

async function funded(opts: Parameters<typeof seedMerchant>[1] = {}, amount = 100_000) {
  const m = await seedMerchant(ctx, opts);
  await collect(ctx, m, amount);
  return m;
}

describe('payout engine', () => {
  it('pays out the eligible balance and settles the ledger on provider confirmation', async () => {
    const m = await funded();
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k1' }, m.actor);
    expect(p.amount_minor).toBe(98_000);
    expect(p.status).toBe('QUEUED');
    expect(await payableOf(ctx, m.merchantId)).toBe(0); // reserved immediately
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
    expect(await clearing()).toBe(0);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(2000); // only the platform fee remains
  });

  it('refuses payouts beyond the eligible balance, without a verified destination, or over limits', async () => {
    const m = await funded();
    await expect(ctx.p.payouts.request(m.merchantId, { amountMinor: 98_001, idempotencyKey: 'a' }, m.actor)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    await ctx.db.query(`UPDATE merchants SET per_payout_limit_minor=50000 WHERE id=$1`, [m.merchantId]);
    await expect(ctx.p.payouts.request(m.merchantId, { amountMinor: 60_000, idempotencyKey: 'b' }, m.actor)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await ctx.db.query(`UPDATE merchants SET per_payout_limit_minor=10000000, daily_payout_limit_minor=70000 WHERE id=$1`, [m.merchantId]);
    await expect(ctx.p.payouts.request(m.merchantId, { amountMinor: 80_000, idempotencyKey: 'c' }, m.actor)).rejects.toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });

    const bare = await seedMerchant(ctx);
    await collect(ctx, bare, 100_000);
    await ctx.db.query(`UPDATE merchant_settlement_destinations SET status='DISABLED' WHERE merchant_id=$1`, [bare.merchantId]);
    await expect(ctx.p.payouts.request(bare.merchantId, { idempotencyKey: 'd' }, bare.actor)).rejects.toMatchObject({ code: 'NO_VERIFIED_DESTINATION' });
  });

  it('is idempotent per key and cannot double-spend under concurrency', async () => {
    const m = await funded();
    const [a, b] = await Promise.all([
      ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'same' }, m.actor),
      ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'same' }, m.actor),
    ]);
    expect(a.id).toBe(b.id);

    const m2 = await funded();
    const results = await Promise.allSettled([
      ctx.p.payouts.request(m2.merchantId, { idempotencyKey: 'x1' }, m2.actor),
      ctx.p.payouts.request(m2.merchantId, { idempotencyKey: 'x2' }, m2.actor),
      ctx.p.payouts.request(m2.merchantId, { idempotencyKey: 'x3' }, m2.actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await payableOf(ctx, m2.merchantId)).toBe(0);
  });

  it('8. a timeout AFTER the provider accepted the payout never produces a second transfer', async () => {
    const m = await funded();
    ctx.provider.payoutBehavior = 'timeout_after_accept';
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.p.jobs.drain(ctx.p.handlers); // attempt 1 times out
    expect((await payout(p.id)).status).toBe('SUBMITTED');
    expect((await payout(p.id)).outcome_unknown).toBe(true);
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture()); // retry finds it at the provider by reference
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
    expect(ctx.provider.payoutCreateCalls).toBe(1);
    expect(await ctx.provider.listPayouts()).toHaveLength(1);
  });

  it('8b. a timeout BEFORE acceptance is retried with the same idempotency key', async () => {
    const m = await funded();
    ctx.provider.payoutBehavior = 'timeout_before_accept';
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect((await payout(p.id)).status).toBe('SUBMITTED');
    ctx.provider.payoutBehavior = 'success';
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture());
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
    expect(await ctx.provider.listPayouts()).toHaveLength(1);
  });

  it('9. a failed payout is not recorded as completed and the funds return to the merchant', async () => {
    const m = await funded();
    ctx.provider.payoutBehavior = 'fail';
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const after = await payout(p.id);
    expect(after.status).toBe('FAILED');
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
    expect(await clearing()).toBe(0);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(100_000);
  });

  it('tracks a processing payout until the provider reports a final result', async () => {
    const m = await funded();
    ctx.provider.payoutBehavior = 'processing';
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect((await payout(p.id)).status).toBe('PROCESSING');
    expect(await clearing()).toBe(98_000);
    const [remote] = await ctx.provider.listPayouts();
    ctx.provider.settlePayout(remote.id, 'processed');
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture());
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
  });

  it('holds an ambiguous payout for review after retries are exhausted, keeping funds reserved', async () => {
    const m = await funded();
    ctx.provider.outage = true;
    ctx.provider.payoutBehavior = 'timeout_before_accept';
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    for (let i = 0; i < 12; i++) await ctx.p.jobs.drain(ctx.p.handlers, new Date(Date.now() + (i + 1) * 3600_000));
    const after = await payout(p.id);
    expect(after.status).toBe('UNDER_REVIEW');
    expect(await payableOf(ctx, m.merchantId)).toBe(0);
    expect((await ctx.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['PAYOUT_UNKNOWN_OUTCOME'])).length).toBe(1);
    // Operator retry: provider lookup still precedes any resubmission.
    ctx.provider.outage = false;
    ctx.provider.payoutBehavior = 'success';
    await ctx.p.payouts.retryUnknown(p.id, ctx.admin);
    await ctx.p.jobs.drain(ctx.p.handlers, farFuture());
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
  });

  it('recovers a payout left SUBMITTED by a crash before the provider call', async () => {
    const m = await funded();
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.db.query(`UPDATE payouts SET status='SUBMITTED' WHERE id=$1`, [p.id]); // crash right after commit of QUEUED->SUBMITTED
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
    expect(ctx.provider.payoutCreateCalls).toBe(1);
  });

  it('15. high-value payouts need a second administrator and cannot be self-approved', async () => {
    const m = await funded({ reviewThreshold: 50_000 });
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, ctx.admin); // admin-initiated
    expect(p.status).toBe('UNDER_REVIEW');
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect(ctx.provider.payoutCreateCalls).toBe(0); // nothing submitted while held
    await expect(ctx.p.payouts.approve(p.id, ctx.admin)).rejects.toMatchObject({ code: 'DUAL_APPROVAL_REQUIRED' });
    await ctx.p.payouts.approve(p.id, ctx.admin2);
    await ctx.p.jobs.drain(ctx.p.handlers);
    expect((await payout(p.id)).status).toBe('SUCCEEDED');
    const audit = await ctx.db.query<any>(`SELECT action FROM audit_logs WHERE subject_id=$1 ORDER BY id`, [p.id]);
    expect(audit.map((a) => a.action)).toEqual(['payout.requested', 'payout.approved']);
  });

  it('rejecting a held payout releases the reserved funds', async () => {
    const m = await funded({ reviewThreshold: 50_000 });
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.p.payouts.reject(p.id, ctx.admin, 'suspicious');
    expect((await payout(p.id)).status).toBe('FAILED');
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
  });

  it('keeps funds inside the settlement hold window out of the eligible balance', async () => {
    const m = await funded({ holdHours: 48 });
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
    await expect(ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor, new Date(Date.now() + 49 * 3600_000));
    expect(p.amount_minor).toBe(98_000);
  });

  it('restores the balance when a completed payout is later returned', async () => {
    const m = await funded();
    const p = await ctx.p.payouts.request(m.merchantId, { idempotencyKey: 'k' }, m.actor);
    await ctx.p.jobs.drain(ctx.p.handlers);
    const [remote] = await ctx.provider.listPayouts();
    ctx.provider.settlePayout(remote.id, 'reversed');
    const run = await ctx.p.reconciliation.run();
    expect(run.items.map((i) => i.kind)).toContain('PAYOUT_SYNCED');
    expect((await payout(p.id)).status).toBe('RETURNED');
    expect(await payableOf(ctx, m.merchantId)).toBe(98_000);
    expect(await ctx.p.ledger.balance(ctx.db, ACCOUNTS.PROVIDER_CLEARING.code)).toBe(100_000);
    expect(await ctx.p.ledger.findUnbalancedJournals(ctx.db)).toHaveLength(0);
  });
});
