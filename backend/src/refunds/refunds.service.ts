import { Db } from '../db/db';
import { DomainError, TransientError } from '../common/errors';
import { assertTransition, PAYMENT_TRANSITIONS } from '../common/state-machine';
import { ACCOUNTS, LedgerService, merchantPayable } from '../ledger/ledger.service';
import { JobsService } from '../jobs/jobs.service';
import { Actor, AuditService } from '../audit/audit.service';
import { PaymentProvider } from '../provider/provider';
import { assertMoneyOutNotFrozen } from '../recovery/flags';

/** Fee is refunded pro rata with integer maths: round(fee * cumulativeRefunded / amount). */
export function cumulativeFeeRefund(fee: number, refunded: number, amount: number): number {
  return Math.floor((2 * fee * refunded + amount) / (2 * amount));
}

export class RefundsService {
  constructor(
    private readonly db: Db,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  async request(paymentId: string, input: { amountMinor: number; idempotencyKey: string; reason?: string }, actor: Actor) {
    if (!input.idempotencyKey) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new DomainError('INVALID_AMOUNT', 'Refund amount must be a positive integer');

    const refund = await this.db.transaction(async (tx) => {
      const [p] = await tx.query<any>('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
      if (!p) throw new DomainError('NOT_FOUND', 'Payment not found', 404);
      await assertMoneyOutNotFrozen(tx);
      const [dup] = await tx.query<any>('SELECT * FROM refunds WHERE payment_id=$1 AND idempotency_key=$2', [paymentId, input.idempotencyKey]);
      if (dup) {
        if (Number(dup.amount_minor) !== input.amountMinor) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different amount', 409);
        return dup;
      }
      if (!['SUCCEEDED', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW'].includes(p.status)) throw new DomainError('NOT_REFUNDABLE', `Payment is ${p.status}`, 409);
      const amount = Number(p.amount_minor);
      const [pend] = await tx.query<{ s: number }>(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM refunds WHERE payment_id=$1 AND status='PENDING'`, [paymentId]);
      const remaining = amount - Number(p.refunded_minor) - Number(pend.s);
      if (input.amountMinor > remaining) throw new DomainError('REFUND_EXCEEDS_PAYMENT', `At most ${remaining} can still be refunded`, 409);
      if (p.status === 'UNDER_REVIEW' && input.amountMinor !== amount) throw new DomainError('FULL_REFUND_ONLY', 'Payments under review can only be refunded in full', 409);

      const fee = Number(p.fee_minor);
      const feeRefund =
        cumulativeFeeRefund(fee, Number(p.refunded_minor) + Number(pend.s) + input.amountMinor, amount) -
        cumulativeFeeRefund(fee, Number(p.refunded_minor) + Number(pend.s), amount);
      const [r] = await tx.query<any>(
        `INSERT INTO refunds(payment_id, merchant_id, amount_minor, fee_refund_minor, idempotency_key, reason, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [paymentId, p.merchant_id, input.amountMinor, feeRefund, input.idempotencyKey, input.reason ?? '', actor.id],
      );
      await this.jobs.enqueue(tx, 'complete_refund', { refundId: r.id }, { dedupeKey: `complete_refund:${r.id}` });
      await this.audit.record(tx, actor, 'refund.requested', 'payment', paymentId, { refundId: r.id, amount: input.amountMinor });
      return r;
    });
    // Try immediately; if the provider is unreachable the queued job completes it later.
    try {
      await this.complete(refund.id);
    } catch (e) {
      if (!(e instanceof TransientError)) throw e;
    }
    const [fresh] = await this.db.query<any>('SELECT * FROM refunds WHERE id=$1', [refund.id]);
    return fresh;
  }

  /** Idempotent. Provider call uses the refund id as its idempotency key, so retries cannot refund twice. */
  async complete(refundId: string): Promise<void> {
    const [r0] = await this.db.query<any>('SELECT * FROM refunds WHERE id=$1', [refundId]);
    if (!r0 || r0.status !== 'PENDING') return;
    // Deliberately NOT blocked by the money-out freeze: a pending refund is completed by replaying createRefund with the refund's own
    // idempotency key, which is how the provider returns the original outcome without refunding twice (required provider capability).
    const [p0] = await this.db.query<any>('SELECT provider_payment_id FROM payments WHERE id=$1', [r0.payment_id]);

    let remote;
    try {
      remote = await this.provider.createRefund({ providerPaymentId: p0.provider_payment_id, amountMinor: Number(r0.amount_minor), idempotencyKey: r0.id });
    } catch (e: any) {
      if (e instanceof TransientError) throw e; // outcome unknown: stay PENDING, retry
      await this.db.query(`UPDATE refunds SET status='FAILED' WHERE id=$1 AND status='PENDING'`, [refundId]);
      throw new DomainError('PROVIDER_REFUND_REJECTED', String(e?.message ?? e), 409);
    }
    if (remote.status === 'pending') throw new TransientError('refund pending at provider');
    if (remote.status === 'failed') {
      await this.db.query(`UPDATE refunds SET status='FAILED' WHERE id=$1 AND status='PENDING'`, [refundId]);
      return;
    }

    await this.db.transaction(async (tx) => {
      const [p] = await tx.query<any>('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [r0.payment_id]);
      const [r] = await tx.query<any>('SELECT * FROM refunds WHERE id=$1 FOR UPDATE', [refundId]);
      if (r.status !== 'PENDING') return;
      const amount = Number(r.amount_minor);
      const feeRefund = Number(r.fee_refund_minor);
      const lines =
        p.status === 'UNDER_REVIEW'
          ? [
              { account: ACCOUNTS.SUSPENSE.code, dir: 'D' as const, amountMinor: amount },
              { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'C' as const, amountMinor: amount },
            ]
          : [
              { account: merchantPayable(p.merchant_id), dir: 'D' as const, amountMinor: amount - feeRefund },
              ...(feeRefund > 0 ? [{ account: ACCOUNTS.FEE_REVENUE.code, dir: 'D' as const, amountMinor: feeRefund }] : []),
              { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'C' as const, amountMinor: amount },
            ];
      await this.ledger.post(tx, { kind: 'REFUND', refType: 'refund', refId: r.id, sandbox: p.is_sandbox, lines });
      const refundedTotal = Number(p.refunded_minor) + amount;
      const next = refundedTotal === Number(p.amount_minor) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      assertTransition(PAYMENT_TRANSITIONS, p.status, next);
      await tx.query(`UPDATE payments SET refunded_minor=$2, status=$3, updated_at=now() WHERE id=$1`, [p.id, refundedTotal, next]);
      await tx.query(`UPDATE refunds SET status='SUCCEEDED', provider_refund_id=$2 WHERE id=$1`, [r.id, remote.id]);
      await tx.query(`INSERT INTO payment_events(payment_request_id, payment_id, kind, detail) VALUES ($1,$2,'REFUNDED',$3)`, [p.payment_request_id, p.id, JSON.stringify({ refundId: r.id, amount })]);
      await tx.query(`INSERT INTO notification_jobs(merchant_id, kind, payload) VALUES ($1,'REFUND_PROCESSED',$2)`, [p.merchant_id, JSON.stringify({ refundId: r.id })]);
    });
  }
}
