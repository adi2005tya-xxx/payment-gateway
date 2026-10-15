import { randomUUID } from 'crypto';
import { Db, Queryable } from '../db/db';
import { DeferJob, DomainError, ProviderRejection, TransientError } from '../common/errors';
import { assertTransition, PAYOUT_TRANSITIONS } from '../common/state-machine';
import { ACCOUNTS, LedgerService, merchantPayable } from '../ledger/ledger.service';
import { JobsService } from '../jobs/jobs.service';
import { Actor, AuditService } from '../audit/audit.service';
import { PaymentProvider, ProviderPayout } from '../provider/provider';
import { assertMoneyOutNotFrozen, isMoneyOutFrozen } from '../recovery/flags';

export class PayoutsService {
  constructor(
    private readonly db: Db,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  /** Payable balance minus amounts still inside the settlement hold window. Derived from the ledger, never stored. */
  async availableBalance(tx: Queryable, merchantId: string, now?: Date) {
    const payable = await this.ledger.balance(tx, merchantPayable(merchantId));
    const [h] = await tx.query<{ held: number }>(
      `SELECT COALESCE(SUM(net_minor),0) AS held FROM payments
        WHERE merchant_id=$1 AND status IN ('SUCCEEDED','PARTIALLY_REFUNDED') AND eligible_at > COALESCE($2::timestamptz, now())`,
      [merchantId, now ? now.toISOString() : null], // default: the DATABASE clock, which also stamped eligible_at (no app/DB clock skew)
    );
    const held = Number(h.held);
    return { payable, held, available: Math.max(0, payable - held) };
  }

  async request(merchantId: string, input: { amountMinor?: number; idempotencyKey: string }, actor: Actor, now?: Date) {
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');
    return this.db.transaction(async (tx) => {
      const [m] = await tx.query<any>('SELECT * FROM merchants WHERE id=$1 FOR UPDATE', [merchantId]); // serialises balance checks
      if (!m) throw new DomainError('NOT_FOUND', 'Merchant not found', 404);

      // A split payout is stored as <key>#0, <key>#1 ...; the request is idempotent as a whole.
      const prior = await tx.query<any>(
        `SELECT * FROM payouts WHERE merchant_id=$1 AND (idempotency_key=$2 OR idempotency_key LIKE $3) ORDER BY idempotency_key`,
        [merchantId, input.idempotencyKey, input.idempotencyKey.replace(/[\\%_]/g, '\\$&') + '#%'],
      );
      const mine = prior.filter((r) => r.idempotency_key === input.idempotencyKey || /#\d+$/.test(r.idempotency_key));
      if (mine.length) {
        const total = mine.reduce((t, r) => t + Number(r.amount_minor), 0);
        if (input.amountMinor !== undefined && total !== input.amountMinor) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different amount', 409);
        return { ...mine[0], group: mine };
      }
      if (m.status !== 'ACTIVE') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant is not active', 403);
      await assertMoneyOutNotFrozen(tx);
      const [dest] = await tx.query<any>(`SELECT * FROM merchant_settlement_destinations WHERE merchant_id=$1 AND status='VERIFIED'`, [merchantId]);
      if (!dest) throw new DomainError('NO_VERIFIED_DESTINATION', 'No verified settlement destination', 409);

      const bal = await this.availableBalance(tx, merchantId, now);
      const amount = input.amountMinor ?? bal.available;
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new DomainError('INVALID_AMOUNT', 'Nothing to pay out', 400);
      if (amount > bal.available) throw new DomainError('INSUFFICIENT_BALANCE', 'Amount exceeds eligible balance', 409);
      if (amount > Number(m.per_payout_limit_minor)) throw new DomainError('LIMIT_EXCEEDED', 'Amount exceeds per-payout limit', 409);
      const [day] = await tx.query<{ s: number }>(
        `SELECT COALESCE(SUM(amount_minor),0) AS s FROM payouts WHERE merchant_id=$1 AND status NOT IN ('FAILED') AND created_at > COALESCE($2::timestamptz, now()) - interval '24 hours'`,
        [merchantId, now ? now.toISOString() : null],
      );
      if (Number(day.s) + amount > Number(m.daily_payout_limit_minor)) throw new DomainError('DAILY_LIMIT_EXCEEDED', 'Daily payout limit exceeded', 409);

      const review = amount >= Number(m.review_threshold_minor);
      const status = review ? 'UNDER_REVIEW' : 'QUEUED';
      assertTransition(PAYOUT_TRANSITIONS, 'ELIGIBLE', status);
      // A payout above the bank's per-transaction cap becomes several transfers (a group); each one is reserved, tracked and
      // reconciled on its own. Review applies to the request as a whole.
      const cap = this.provider.payoutLimitMinor && this.provider.payoutLimitMinor > 0 ? this.provider.payoutLimitMinor : amount;
      const parts: number[] = [];
      for (let left = amount; left > 0; left -= Math.min(left, cap)) parts.push(Math.min(left, cap));
      const group = parts.length > 1 ? randomUUID() : null;
      const rows: any[] = [];
      for (const [i, part] of parts.entries()) {
        const [row] = await tx.query<any>(
          `INSERT INTO payouts(merchant_id, destination_id, amount_minor, status, idempotency_key, provider, requested_by, is_sandbox, payout_group)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [merchantId, dest.id, part, status, group ? `${input.idempotencyKey}#${i}` : input.idempotencyKey, this.provider.name, actor.id, this.provider.isSandbox, group],
        );
        // Reserve the funds immediately so the same balance cannot be paid out twice.
        await this.ledger.post(tx, {
          kind: 'PAYOUT_RESERVE', refType: 'payout', refId: row.id, sandbox: row.is_sandbox,
          lines: [
            { account: merchantPayable(merchantId), dir: 'D', amountMinor: part },
            { account: ACCOUNTS.PAYOUT_CLEARING.code, dir: 'C', amountMinor: part },
          ],
        });
        await this.event(tx, row.id, 'ELIGIBLE', status, { amount: part, group, part: i + 1, of: parts.length });
        if (review) {
          await tx.query(`INSERT INTO risk_reviews(subject_type, subject_id, reason, detail) VALUES ('payout',$1,'PAYOUT_OVER_REVIEW_THRESHOLD',$2)`, [row.id, JSON.stringify({ amount: part, total: amount })]);
        } else {
          await this.enqueueAdvance(tx, row.id);
        }
        rows.push(row);
      }
      const p = rows[0];
      await this.audit.record(tx, actor, 'payout.requested', 'payout', p.id, { amount, status, parts: parts.length });
      return { ...p, group: rows };
    });
  }

  /** Dual control: the approver must be a different user from the requester. */
  async approve(payoutId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [first] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1', [payoutId]);
      if (!first) throw new DomainError('NOT_FOUND', 'Payout not found', 404);
      // Approving one part of a split payout approves the whole request.
      const rows = first.payout_group
        ? await tx.query<any>('SELECT * FROM payouts WHERE payout_group=$1 ORDER BY idempotency_key FOR UPDATE', [first.payout_group])
        : await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      for (const p of rows) {
        if (p.requested_by && p.requested_by === actor.id) throw new DomainError('DUAL_APPROVAL_REQUIRED', 'Requester cannot approve their own payout', 403);
        assertTransition(PAYOUT_TRANSITIONS, p.status, 'QUEUED');
        await tx.query(`UPDATE payouts SET status='QUEUED', approved_by=$2, updated_at=now() WHERE id=$1`, [p.id, actor.id]);
        await this.event(tx, p.id, p.status, 'QUEUED', { approvedBy: actor.id });
        await tx.query(`UPDATE risk_reviews SET status='APPROVED', decided_by=$2, decided_at=now() WHERE subject_type='payout' AND subject_id=$1 AND status='OPEN'`, [p.id, actor.id]);
        await this.enqueueAdvance(tx, p.id);
        await this.audit.record(tx, actor, 'payout.approved', 'payout', p.id);
      }
    });
  }

  /** Rejects a held payout and releases the reserved funds back to the merchant. */
  async reject(payoutId: string, actor: Actor, reason: string) {
    return this.db.transaction(async (tx) => {
      const [first] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1', [payoutId]);
      if (!first) throw new DomainError('NOT_FOUND', 'Payout not found', 404);
      const rows = first.payout_group
        ? await tx.query<any>('SELECT * FROM payouts WHERE payout_group=$1 ORDER BY idempotency_key FOR UPDATE', [first.payout_group])
        : await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      for (const p of rows) {
        if (p.provider_payout_id) throw new DomainError('ALREADY_SUBMITTED', 'Payout already exists at the provider; resync instead', 409);
        assertTransition(PAYOUT_TRANSITIONS, p.status, 'FAILED');
        await this.markFailed(tx, p, reason);
        await tx.query(`UPDATE risk_reviews SET status='REJECTED', decided_by=$2, decided_at=now() WHERE subject_type='payout' AND subject_id=$1 AND status='OPEN'`, [p.id, actor.id]);
        await this.audit.record(tx, actor, 'payout.rejected', 'payout', p.id, { reason });
      }
    });
  }

  /** Re-drives a payout stuck UNDER_REVIEW because its outcome was unknown. Provider lookup always precedes any resubmission. */
  async retryUnknown(payoutId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      if (!p) throw new DomainError('NOT_FOUND', 'Payout not found', 404);
      assertTransition(PAYOUT_TRANSITIONS, p.status, 'QUEUED');
      await tx.query(`UPDATE payouts SET status='QUEUED', updated_at=now() WHERE id=$1`, [payoutId]);
      await this.event(tx, payoutId, p.status, 'QUEUED', { retriedBy: actor.id });
      await this.enqueueAdvance(tx, payoutId);
      await this.audit.record(tx, actor, 'payout.retry_unknown', 'payout', payoutId);
    });
  }

  /**
   * Job handler. Drives a payout toward a definitive result. Crash-safe and retry-safe:
   *  1. QUEUED -> SUBMITTED is committed BEFORE the provider is called, so a restart sees an in-flight payout.
   *  2. The provider is queried by our reference first; a payout is created only if the provider has none,
   *     and always with the same idempotency key, so a timeout can never produce a second transfer.
   */
  async advance(payoutId: string, ctx: { attempt: number; maxAttempts: number }, now: Date = new Date()): Promise<void> {
    // After a restore/failover nothing may reach the provider until reconciliation clears the freeze.
    if (await isMoneyOutFrozen(this.db)) throw new DeferJob(60_000, 'money-out frozen');
    const [pre] = await this.db.query<any>('SELECT status, amount_minor FROM payouts WHERE id=$1', [payoutId]);
    if (pre?.status === 'QUEUED') await this.ensureLiquidity(payoutId, Number(pre.amount_minor)); // not yet sent anywhere: stay QUEUED
    const p = await this.db.transaction(async (tx) => {
      const [row] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      if (!row) throw new DomainError('NOT_FOUND', 'Payout not found', 404);
      if (row.status === 'QUEUED') {
        assertTransition(PAYOUT_TRANSITIONS, 'QUEUED', 'SUBMITTED');
        await tx.query(`UPDATE payouts SET status='SUBMITTED', submit_attempts = submit_attempts + 1, updated_at=now() WHERE id=$1`, [payoutId]);
        await this.event(tx, payoutId, 'QUEUED', 'SUBMITTED');
        row.status = 'SUBMITTED';
      }
      return row;
    });
    if (p.status !== 'SUBMITTED' && p.status !== 'PROCESSING') return; // terminal or held: nothing to drive

    try {
      let remote = await this.provider.getPayoutByReference(p.id);
      if (!remote) {
        await this.ensureLiquidity(p.id, Number(p.amount_minor));
        const [dest] = await this.db.query<any>('SELECT provider_destination_ref FROM merchant_settlement_destinations WHERE id=$1', [p.destination_id]);
        remote = await this.provider.createPayout({
          referenceId: p.id,
          amountMinor: Number(p.amount_minor),
          currency: p.currency.trim(),
          destinationRef: dest.provider_destination_ref,
          idempotencyKey: p.id,
        });
      }
      await this.applyProviderPayout(p.id, remote);
      const [after] = await this.db.query<any>('SELECT status FROM payouts WHERE id=$1', [p.id]);
      if (after.status === 'PROCESSING') throw new TransientError('payout still processing at provider');
    } catch (e: any) {
      if (e instanceof DeferJob) throw e; // nothing was sent: not an unknown outcome
      if (e instanceof ProviderRejection) {
        // Definitive refusal (limit, unknown beneficiary, insufficient funds...): nothing executed, so release the reservation.
        await this.db.transaction(async (tx) => {
          const [row] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [p.id]);
          if (!row || !['SUBMITTED', 'PROCESSING'].includes(row.status)) return;
          await this.markFailed(tx, row, `PROVIDER_REJECTED:${e.code}`);
          await this.audit.record(tx, { id: null, role: 'SYSTEM' }, 'payout.provider_rejected', 'payout', p.id, { code: e.code });
        });
        return;
      }
      if (e instanceof TransientError) {
        await this.db.query('UPDATE payouts SET outcome_unknown = true WHERE id=$1 AND status IN (\'SUBMITTED\',\'PROCESSING\')', [p.id]);
        if (ctx.attempt >= ctx.maxAttempts) await this.escalate(p.id, e.message);
      }
      throw e;
    }
  }

  /** The account payouts leave from must hold the money. If it does not, the payout waits (alert, no provider call) instead of being refused. */
  private async ensureLiquidity(payoutId: string, amount: number) {
    if (!this.provider.getBalance) return;
    const balance = await this.provider.getBalance();
    if (balance >= amount) return;
    const seen = await this.db.query(`SELECT 1 FROM alerts WHERE kind='PROVIDER_BALANCE_LOW' AND detail->>'payoutId'=$1`, [payoutId]);
    if (!seen.length) await this.db.query(`INSERT INTO alerts(kind, detail) VALUES ('PROVIDER_BALANCE_LOW', $1)`, [JSON.stringify({ payoutId, needed: amount, available: balance })]);
    throw new DeferJob(5 * 60_000, 'provider balance too low for this payout');
  }

  /** Applies the provider's reported payout state to our records. Idempotent; never regresses a terminal state. */
  async applyProviderPayout(payoutId: string, remote: ProviderPayout): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [p] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      if (Number(remote.amountMinor) !== Number(p.amount_minor)) {
        await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('PAYOUT_AMOUNT_MISMATCH', $1)`, [JSON.stringify({ payoutId, expected: Number(p.amount_minor), provider: remote.amountMinor })]);
        if (['SUBMITTED', 'PROCESSING'].includes(p.status)) await this.toReview(tx, p, 'PROVIDER_AMOUNT_MISMATCH');
        return;
      }
      if (!p.provider_payout_id) await tx.query('UPDATE payouts SET provider_payout_id=$2 WHERE id=$1', [payoutId, remote.id]);
      if (p.status === 'QUEUED') {
        // The provider already holds this payout although our record never left QUEUED (e.g. restored from an older backup): adopt its state.
        await tx.query(`UPDATE payouts SET status='SUBMITTED', updated_at=now() WHERE id=$1`, [payoutId]);
        await this.event(tx, payoutId, 'QUEUED', 'SUBMITTED', { adoptedFromProvider: remote.id });
        p.status = 'SUBMITTED';
      }

      switch (remote.status) {
        case 'processing':
          if (p.status === 'SUBMITTED') {
            await tx.query(`UPDATE payouts SET status='PROCESSING', outcome_unknown=false, updated_at=now() WHERE id=$1`, [payoutId]);
            await this.event(tx, payoutId, 'SUBMITTED', 'PROCESSING', { providerPayoutId: remote.id });
          }
          return;
        case 'processed':
          if (p.status === 'SUCCEEDED') return;
          if (!['SUBMITTED', 'PROCESSING', 'UNDER_REVIEW'].includes(p.status)) return;
          if (p.status === 'UNDER_REVIEW') await tx.query(`UPDATE payouts SET status='SUBMITTED' WHERE id=$1`, [payoutId]); // review/escalation resolved by provider truth
          await this.ledger.post(tx, {
            kind: 'PAYOUT_COMPLETE', refType: 'payout', refId: payoutId, sandbox: p.is_sandbox,
            lines: [
              { account: ACCOUNTS.PAYOUT_CLEARING.code, dir: 'D', amountMinor: Number(p.amount_minor) },
              { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'C', amountMinor: Number(p.amount_minor) },
            ],
          });
          await tx.query(`UPDATE payouts SET status='SUCCEEDED', outcome_unknown=false, updated_at=now() WHERE id=$1`, [payoutId]);
          await this.event(tx, payoutId, p.status, 'SUCCEEDED', { providerPayoutId: remote.id });
          await tx.query(`INSERT INTO notification_jobs(merchant_id, kind, payload) VALUES ($1,'PAYOUT_SUCCEEDED',$2)`, [p.merchant_id, JSON.stringify({ payoutId })]);
          return;
        case 'failed':
          if (['SUBMITTED', 'PROCESSING', 'UNDER_REVIEW'].includes(p.status)) await this.markFailed(tx, p, 'PROVIDER_FAILED');
          return;
        case 'reversed':
          if (p.status === 'SUCCEEDED') {
            // Funds came back after completion: restore the payable.
            await this.ledger.post(tx, {
              kind: 'PAYOUT_RETURN', refType: 'payout', refId: payoutId, sandbox: p.is_sandbox,
              lines: [
                { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'D', amountMinor: Number(p.amount_minor) },
                { account: merchantPayable(p.merchant_id), dir: 'C', amountMinor: Number(p.amount_minor) },
              ],
            });
            await tx.query(`UPDATE payouts SET status='RETURNED', updated_at=now() WHERE id=$1`, [payoutId]);
            await this.event(tx, payoutId, 'SUCCEEDED', 'RETURNED');
            await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('PAYOUT_RETURNED', $1)`, [JSON.stringify({ payoutId })]);
          } else if (['SUBMITTED', 'PROCESSING', 'UNDER_REVIEW'].includes(p.status)) {
            await this.markFailed(tx, p, 'PROVIDER_REVERSED');
          }
          return;
      }
    });
  }

  private async markFailed(tx: Queryable, p: any, reason: string) {
    assertTransition(PAYOUT_TRANSITIONS, p.status, 'FAILED');
    await this.ledger.post(tx, {
      kind: 'PAYOUT_RELEASE', refType: 'payout', refId: p.id, sandbox: p.is_sandbox,
      lines: [
        { account: ACCOUNTS.PAYOUT_CLEARING.code, dir: 'D', amountMinor: Number(p.amount_minor) },
        { account: merchantPayable(p.merchant_id), dir: 'C', amountMinor: Number(p.amount_minor) },
      ],
    });
    await tx.query(`UPDATE payouts SET status='FAILED', failure_reason=$2, outcome_unknown=false, updated_at=now() WHERE id=$1`, [p.id, reason]);
    await this.event(tx, p.id, p.status, 'FAILED', { reason });
    await tx.query(`INSERT INTO notification_jobs(merchant_id, kind, payload) VALUES ($1,'PAYOUT_FAILED',$2)`, [p.merchant_id, JSON.stringify({ payoutId: p.id, reason })]);
  }

  private async toReview(tx: Queryable, p: any, reason: string) {
    assertTransition(PAYOUT_TRANSITIONS, p.status, 'UNDER_REVIEW');
    await tx.query(`UPDATE payouts SET status='UNDER_REVIEW', updated_at=now() WHERE id=$1`, [p.id]);
    await this.event(tx, p.id, p.status, 'UNDER_REVIEW', { reason });
    await tx.query(`INSERT INTO risk_reviews(subject_type, subject_id, reason) VALUES ('payout',$1,$2)`, [p.id, reason]);
  }

  /** Called when retries are exhausted without a definitive provider answer: hold for a human, keep funds reserved. */
  private async escalate(payoutId: string, why: string) {
    await this.db.transaction(async (tx) => {
      const [p] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      if (!['SUBMITTED', 'PROCESSING'].includes(p.status)) return;
      await this.toReview(tx, p, 'UNKNOWN_OUTCOME');
      await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('PAYOUT_UNKNOWN_OUTCOME', $1)`, [JSON.stringify({ payoutId, why })]);
    });
  }

  private async event(tx: Queryable, payoutId: string, from: string | null, to: string, detail: Record<string, unknown> = {}) {
    await tx.query('INSERT INTO payout_events(payout_id, from_status, to_status, detail) VALUES ($1,$2,$3,$4)', [payoutId, from, to, JSON.stringify(detail)]);
  }

  private async enqueueAdvance(tx: Queryable, payoutId: string) {
    const [c] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM payout_events WHERE payout_id=$1', [payoutId]);
    await this.jobs.enqueue(tx, 'advance_payout', { payoutId }, { dedupeKey: `advance_payout:${payoutId}:${Number(c.n)}` });
  }
}
