import { Db, Queryable } from '../db/db';
import { DomainError, TransientError } from '../common/errors';
import { feeFor } from '../common/money';
import { assertTransition, PAYMENT_TRANSITIONS } from '../common/state-machine';
import { ACCOUNTS, LedgerService, merchantPayable } from '../ledger/ledger.service';
import { JobsService } from '../jobs/jobs.service';
import { AuditService, Actor, SYSTEM_ACTOR } from '../audit/audit.service';
import { PaymentProvider, ProviderPayment } from '../provider/provider';

export type ApplyResult =
  | { outcome: 'SUCCEEDED'; paymentId: string }
  | { outcome: 'UNDER_REVIEW'; paymentId: string; reasons: string[] }
  | { outcome: 'FAILED'; paymentId: string }
  | { outcome: 'DUPLICATE'; paymentId: string };

/**
 * The payment verification engine. Customer-side success, screenshots and webhook payloads are never trusted:
 * a webhook only *triggers* verification, and the decision is made from the provider's current payment record.
 */
/** The payload column is JSON. JSON bodies are stored as-is; anything else (e.g. Paytm's form-encoded notification) is stored as a JSON string and read back verbatim. */
function storablePayload(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return JSON.stringify(raw);
  }
}

export class VerificationService {
  constructor(
    private readonly db: Db,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  /** Steps 1-6: authenticate, validate, persist durably, dedupe, enqueue. Acknowledge only after this returns. */
  async ingestWebhook(rawBody: string, signature: string | undefined): Promise<{ accepted: true; duplicate: boolean }> {
    if (!this.provider.verifyWebhook(rawBody, signature)) {
      await this.db.query(`INSERT INTO alerts(kind, detail) VALUES ('WEBHOOK_SIGNATURE_FAILURE', $1)`, [JSON.stringify({ provider: this.provider.name, bytes: rawBody.length })]);
      throw new DomainError('INVALID_SIGNATURE', 'Invalid webhook signature', 401);
    }
    let parsed;
    try {
      parsed = this.provider.parseWebhook(rawBody);
    } catch {
      throw new DomainError('MALFORMED_EVENT', 'Malformed webhook payload', 400);
    }
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO webhook_events(provider, provider_event_id, event_type, payload) VALUES ($1,$2,$3,$4)
         ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
        [this.provider.name, parsed.eventId, parsed.type, storablePayload(rawBody)],
      );
      if (rows.length === 0) return { accepted: true as const, duplicate: true };
      await this.jobs.enqueue(tx, 'process_webhook', { webhookEventId: rows[0].id }, { dedupeKey: `webhook:${rows[0].id}` });
      return { accepted: true as const, duplicate: false };
    });
  }

  /** Job handler for a stored webhook event. Safe to run repeatedly. */
  async processWebhookEvent(webhookEventId: string, ctx: { attempt: number; maxAttempts: number }): Promise<void> {
    const [ev] = await this.db.query<any>('SELECT * FROM webhook_events WHERE id=$1', [webhookEventId]);
    if (!ev || ev.status === 'PROCESSED' || ev.status === 'IGNORED') return;
    try {
      const parsed = this.provider.parseWebhook(typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload));
      if (!parsed.providerPaymentId || !parsed.type.startsWith('payment.')) {
        await this.db.query(`UPDATE webhook_events SET status='IGNORED', processed_at=now() WHERE id=$1`, [webhookEventId]);
        return;
      }
      await this.db.query('UPDATE webhook_events SET attempts = attempts + 1 WHERE id=$1', [webhookEventId]);
      // Authoritative state comes from the provider, not from the webhook body.
      const pp = await this.provider.getPayment(parsed.providerPaymentId);
      await this.applyProviderPayment(pp);
      await this.db.query(`UPDATE webhook_events SET status='PROCESSED', processed_at=now(), last_error=NULL WHERE id=$1`, [webhookEventId]);
    } catch (e: any) {
      const dead = ctx.attempt >= ctx.maxAttempts;
      await this.db.query(`UPDATE webhook_events SET last_error=$2, status=$3 WHERE id=$1`, [webhookEventId, String(e?.message ?? e).slice(0, 500), dead ? 'FAILED' : 'RECEIVED']);
      throw e; // job runner retries with backoff / dead-letters
    }
  }

  /** Steps 7-15, atomically. Idempotent per (provider, provider_payment_id). */
  async applyProviderPayment(pp: ProviderPayment): Promise<ApplyResult> {
    if (pp.status === 'pending' || pp.status === 'created') {
      throw new TransientError('payment not final at provider; keeping unresolved'); // never guess an outcome
    }
    return this.db.transaction(async (tx) => {
      // Lock order: request row first, then payment row, so concurrent events for one order serialise.
      const [req] = await tx.query<any>('SELECT * FROM payment_requests WHERE provider_order_id=$1 FOR UPDATE', [pp.orderId]);
      const [existing] = await tx.query<any>('SELECT * FROM payments WHERE provider=$1 AND provider_payment_id=$2 FOR UPDATE', [this.provider.name, pp.id]);
      if (existing) return { outcome: 'DUPLICATE' as const, paymentId: existing.id };

      if (pp.status === 'failed') {
        const [p] = await tx.query<any>(
          `INSERT INTO payments(payment_request_id, merchant_id, provider, provider_payment_id, provider_order_id, amount_minor, currency, status, is_sandbox)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'FAILED',$8) RETURNING id`,
          [req?.id ?? null, req?.merchant_id ?? null, this.provider.name, pp.id, pp.orderId, pp.amountMinor, pp.currency, this.provider.isSandbox],
        );
        await tx.query(`INSERT INTO payment_events(payment_request_id, payment_id, kind) VALUES ($1,$2,'PAYMENT_FAILED')`, [req?.id ?? null, p.id]);
        return { outcome: 'FAILED' as const, paymentId: p.id };
      }
      if (pp.status !== 'captured') {
        // e.g. 'refunded' for a payment we never recorded: do not credit; reconciliation will surface it.
        throw new DomainError('UNEXPECTED_PROVIDER_STATE', `Unhandled provider status ${pp.status} for unknown payment`, 409);
      }

      const reasons: string[] = [];
      let merchant: any = null;
      if (!req) reasons.push('UNKNOWN_ORDER');
      else {
        [merchant] = await tx.query<any>('SELECT * FROM merchants WHERE id=$1', [req.merchant_id]);
        if (pp.merchantRef !== req.merchant_id) reasons.push('MERCHANT_MISMATCH');
        if (pp.amountMinor !== Number(req.amount_minor) || pp.currency !== req.currency.trim()) reasons.push('AMOUNT_MISMATCH');
        if (req.status === 'PAID') reasons.push('DUPLICATE_PAYMENT_FOR_ORDER');
        else if (req.status !== 'PENDING') reasons.push(`REQUEST_${req.status}`);
        if (merchant.status !== 'ACTIVE') reasons.push('MERCHANT_NOT_ACTIVE');
      }

      const base = [req?.id ?? null, req?.merchant_id ?? null, this.provider.name, pp.id, pp.orderId, pp.amountMinor, pp.currency];
      if (reasons.length === 0) {
        const fee = feeFor(pp.amountMinor, merchant.fee_bps);
        const [p] = await tx.query<any>(
          `INSERT INTO payments(payment_request_id, merchant_id, provider, provider_payment_id, provider_order_id, amount_minor, currency,
                                status, fee_minor, net_minor, eligible_at, is_sandbox)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'SUCCEEDED',$8,$9, now() + ($10 || ' hours')::interval, $11) RETURNING id`,
          [...base, fee, pp.amountMinor - fee, String(merchant.settlement_hold_hours), this.provider.isSandbox],
        );
        const lines = [
          { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'D' as const, amountMinor: pp.amountMinor },
          { account: merchantPayable(req.merchant_id), dir: 'C' as const, amountMinor: pp.amountMinor - fee },
          ...(fee > 0 ? [{ account: ACCOUNTS.FEE_REVENUE.code, dir: 'C' as const, amountMinor: fee }] : []),
        ];
        await this.ledger.post(tx, { kind: 'COLLECTION', refType: 'payment', refId: p.id, currency: pp.currency, sandbox: this.provider.isSandbox, lines });
        await tx.query(`UPDATE payment_requests SET status='PAID', updated_at=now() WHERE id=$1`, [req.id]);
        await tx.query(`INSERT INTO payment_events(payment_request_id, payment_id, kind, detail) VALUES ($1,$2,'PAYMENT_VERIFIED',$3)`, [req.id, p.id, JSON.stringify({ providerPaymentId: pp.id })]);
        await tx.query(`INSERT INTO notification_jobs(merchant_id, kind, payload) VALUES ($1,'PAYMENT_RECEIVED',$2)`, [req.merchant_id, JSON.stringify({ paymentId: p.id, amountMinor: pp.amountMinor })]);
        await this.audit.record(tx, SYSTEM_ACTOR, 'payment.verified', 'payment', p.id, { providerPaymentId: pp.id });
        return { outcome: 'SUCCEEDED' as const, paymentId: p.id };
      }

      // Captured at the provider but not cleanly attributable: funds are real, so they are held in suspense
      // (never credited to a merchant) until a human resolves the review.
      const [p] = await tx.query<any>(
        `INSERT INTO payments(payment_request_id, merchant_id, provider, provider_payment_id, provider_order_id, amount_minor, currency,
                              status, verification_result, is_sandbox)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'UNDER_REVIEW',$8,$9) RETURNING id`,
        [...base, reasons.join(','), this.provider.isSandbox],
      );
      await this.ledger.post(tx, {
        kind: 'SUSPENSE_IN', refType: 'payment', refId: p.id, currency: pp.currency, sandbox: this.provider.isSandbox,
        lines: [
          { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'D', amountMinor: pp.amountMinor },
          { account: ACCOUNTS.SUSPENSE.code, dir: 'C', amountMinor: pp.amountMinor },
        ],
      });
      if (req && req.status === 'PENDING') await tx.query(`UPDATE payment_requests SET status='UNDER_REVIEW', updated_at=now() WHERE id=$1`, [req.id]);
      await tx.query(`INSERT INTO risk_reviews(subject_type, subject_id, reason, detail) VALUES ('payment',$1,$2,$3)`, [
        p.id, reasons.join(','), JSON.stringify({ expected: req ? Number(req.amount_minor) : null, received: pp.amountMinor, providerPaymentId: pp.id }),
      ]);
      await tx.query(`INSERT INTO payment_events(payment_request_id, payment_id, kind, detail) VALUES ($1,$2,'PAYMENT_UNDER_REVIEW',$3)`, [req?.id ?? null, p.id, JSON.stringify({ reasons })]);
      return { outcome: 'UNDER_REVIEW' as const, paymentId: p.id, reasons };
    });
  }

  /** Admin resolves an UNDER_REVIEW payment by attributing it to its merchant (moves suspense -> merchant payable + fee). */
  async approveReviewedPayment(paymentId: string, actor: Actor) {
    return this.db.transaction(async (tx: Queryable) => {
      const [p] = await tx.query<any>('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
      if (!p) throw new DomainError('NOT_FOUND', 'Payment not found', 404);
      assertTransition(PAYMENT_TRANSITIONS, p.status, 'SUCCEEDED');
      if (!p.merchant_id || !p.payment_request_id) throw new DomainError('UNATTRIBUTABLE', 'Payment has no merchant/request; refund it instead', 409);
      const [m] = await tx.query<any>('SELECT * FROM merchants WHERE id=$1', [p.merchant_id]);
      if (m.status !== 'ACTIVE') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant not active', 409);
      const fee = feeFor(Number(p.amount_minor), m.fee_bps);
      await this.ledger.post(tx, {
        kind: 'SUSPENSE_RELEASE', refType: 'payment', refId: p.id, currency: p.currency, sandbox: p.is_sandbox,
        lines: [
          { account: ACCOUNTS.SUSPENSE.code, dir: 'D', amountMinor: Number(p.amount_minor) },
          { account: merchantPayable(p.merchant_id), dir: 'C', amountMinor: Number(p.amount_minor) - fee },
          ...(fee > 0 ? [{ account: ACCOUNTS.FEE_REVENUE.code, dir: 'C' as const, amountMinor: fee }] : []),
        ],
      });
      await tx.query(
        `UPDATE payments SET status='SUCCEEDED', verification_result='MANUALLY_APPROVED', fee_minor=$2, net_minor=$3,
                eligible_at = now() + ($4 || ' hours')::interval, updated_at=now() WHERE id=$1`,
        [p.id, fee, Number(p.amount_minor) - fee, String(m.settlement_hold_hours)],
      );
      await tx.query(`UPDATE payment_requests SET status='PAID', updated_at=now() WHERE id=$1 AND status IN ('UNDER_REVIEW','PENDING','EXPIRED')`, [p.payment_request_id]);
      await tx.query(`UPDATE risk_reviews SET status='APPROVED', decided_by=$2, decided_at=now() WHERE subject_type='payment' AND subject_id=$1 AND status='OPEN'`, [p.id, actor.id]);
      await this.audit.record(tx, actor, 'payment.review.approved', 'payment', p.id);
    });
  }
}
