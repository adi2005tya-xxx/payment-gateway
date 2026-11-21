import { randomBytes, randomUUID } from 'crypto';
import { Db } from '../db/db';
import { DomainError } from '../common/errors';
import { assertAmount } from '../common/money';
import { Actor, AuditService } from '../audit/audit.service';
import { PaymentProvider } from '../provider/provider';
import { isValidVpaFormat, normaliseVpa } from '../provider/sandbox-bank.provider';

/** Rejects QR payloads that are empty, oversized or not a link/UPI intent. The image is never proof of payment. */
export function validateQrPayload(payload: string): void {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > 1024) throw new DomainError('INVALID_QR', 'QR payload invalid');
  if (!/^(https:\/\/|http:\/\/localhost|upi:\/\/pay\?)/.test(payload)) throw new DomainError('INVALID_QR', 'QR payload must be an https link or UPI intent');
}

export class PaymentRequestsService {
  constructor(private readonly db: Db, private readonly provider: PaymentProvider, private readonly audit: AuditService) {}

  async create(
    merchantId: string,
    input: { orderReference: string; description?: string; amountMinor: number; currency?: string; expiresInMinutes?: number; payeeVpa?: string; uniqueAmount?: boolean },
    actor: Actor,
  ) {
    const currency = input.currency ?? 'INR';
    assertAmount(input.amountMinor, currency);
    if (!input.orderReference || input.orderReference.length > 100) throw new DomainError('INVALID_ORDER_REFERENCE', 'orderReference required (max 100 chars)');

    const [m] = await this.db.query<any>('SELECT * FROM merchants WHERE id=$1', [merchantId]);
    if (!m) throw new DomainError('NOT_FOUND', 'Merchant not found', 404);
    if (m.status !== 'ACTIVE') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant is not active', 403);

    const dup = await this.db.query('SELECT id FROM payment_requests WHERE merchant_id=$1 AND order_reference=$2', [merchantId, input.orderReference]);
    if (dup.length) throw new DomainError('DUPLICATE_ORDER_REFERENCE', 'A payment request with this order reference already exists', 409);

    let payeeVpa: string | undefined;
    if (input.payeeVpa !== undefined) {
      if (!this.provider.supportsPayeeVpa) throw new DomainError('PAYEE_NOT_SUPPORTED', 'This payment mode does not accept a custom payee UPI ID', 400);
      if (!isValidVpaFormat(input.payeeVpa)) throw new DomainError('INVALID_VPA', 'Not a valid UPI ID (expected name@bank)');
      payeeVpa = normaliseVpa(input.payeeVpa);
    } else if (this.provider.supportsPayeeVpa) {
      throw new DomainError('PAYEE_REQUIRED', 'Enter the UPI ID that will receive the payment');
    }
    const minutes = input.expiresInMinutes ?? this.provider.defaultOrderExpiryMinutes;
    const id = randomUUID();
    const expiresAt = minutes ? new Date(Date.now() + minutes * 60_000) : undefined;
    // merchantRef lets us confirm at verification time that the provider payment belongs to this merchant.
    const uniq = !!input.uniqueAmount;
    if (uniq && !this.provider.supportsPayeeVpa) throw new DomainError('UNIQUE_AMOUNT_NOT_SUPPORTED', 'Unique payable amounts are only used in bank-email/phone-evidence mode', 400);
    const maxExtraPaise = uniq ? Math.min(99, this.provider.uniqueAmountMaxPaise ?? 99) : 0;
    for (let extra = 0; extra <= maxExtraPaise; extra++) {
      const payable = input.amountMinor + extra;
      assertAmount(payable, currency);
      const order = await this.provider.createOrder({
        referenceId: id,
        merchantRef: merchantId,
        amountMinor: payable,
        currency,
        expiresAt,
        merchantName: m.display_name,
        payeeVpa,
      });
      validateQrPayload(order.qrPayload);
      try {
        return await this.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO payment_requests(id, merchant_id, order_reference, description, amount_minor, currency, status, provider,
                                          provider_order_id, public_token, qr_payload, expires_at, is_sandbox, payee_vpa, unique_amount, base_amount_minor)
             VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [id, merchantId, input.orderReference, input.description ?? '', payable, currency, this.provider.name, order.providerOrderId,
             randomBytes(18).toString('base64url'), order.qrPayload, expiresAt?.toISOString() ?? null, this.provider.isSandbox, payeeVpa ?? null, uniq, uniq ? input.amountMinor : null],
          );
          await tx.query(`INSERT INTO payment_events(payment_request_id, kind, detail) VALUES ($1,'REQUEST_CREATED',$2)`, [id, JSON.stringify({ providerOrderId: order.providerOrderId, uniqueExtraPaise: uniq ? extra : undefined })]);
          await this.audit.record(tx, actor, 'payment_request.created', 'payment_request', id, { amountMinor: payable, baseAmountMinor: uniq ? input.amountMinor : undefined });
          const [row] = await tx.query<any>('SELECT * FROM payment_requests WHERE id=$1', [id]);
          return { ...row, checkoutUrl: order.checkoutUrl };
        });
      } catch (e: any) {
        // Another open order already holds this exact payable amount: try the next paise value.
        if (uniq && String(e?.message ?? '').includes('payment_requests_unique_pending_amount') || e?.constraint === 'payment_requests_unique_pending_amount') continue;
        throw e;
      }
    }
    throw new DomainError('TOO_MANY_OPEN_ORDERS_FOR_AMOUNT', 'No distinct payable amount is free for this amount right now; wait for open orders to expire or use a different amount', 409);
  }

  /** Cancels an unpaid request. Row-locked so it cannot race with a payment being applied. */
  async cancel(merchantId: string, requestId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.query<any>('SELECT * FROM payment_requests WHERE id=$1 AND merchant_id=$2 FOR UPDATE', [requestId, merchantId]);
      if (!r) throw new DomainError('NOT_FOUND', 'Payment request not found', 404);
      if (r.status !== 'PENDING') throw new DomainError('NOT_CANCELLABLE', `Cannot cancel a ${r.status} request`, 409);
      await tx.query(`UPDATE payment_requests SET status='CANCELLED', updated_at=now() WHERE id=$1`, [requestId]);
      await this.audit.record(tx, actor, 'payment_request.cancelled', 'payment_request', requestId);
    });
  }

  async expireStale(): Promise<number> {
    // A grace period (bank-email mode) keeps an order PENDING a while after expiry so a delayed bank alert can still confirm it.
    const grace = this.provider.orderExpiryGraceMinutes ?? 0;
    const rows = await this.db.query(`UPDATE payment_requests SET status='EXPIRED', updated_at=now() WHERE status='PENDING' AND expires_at < now() - make_interval(mins => $1::int) RETURNING id`, [grace]);
    return rows.length;
  }

  /** What a browser-side custom checkout needs to start a payment for this link. Amount and order come from OUR record, never from the client. */
  async checkoutParams(token: string) {
    const [r] = await this.db.query<any>(
      `SELECT r.amount_minor, r.currency, r.description, r.status, r.provider, r.provider_order_id, m.display_name AS merchant_name
         FROM payment_requests r JOIN merchants m ON m.id = r.merchant_id WHERE r.public_token=$1`,
      [token],
    );
    if (!r) throw new DomainError('NOT_FOUND', 'Payment link not found', 404);
    return { provider: r.provider as string, status: r.status as string, orderId: r.provider_order_id as string, amountMinor: Number(r.amount_minor), currency: String(r.currency).trim(), merchantName: r.merchant_name as string, description: r.description as string };
  }

  /** Public checkout view: only what a customer needs to see. */
  async publicView(token: string) {
    const [r] = await this.db.query<any>(
      `SELECT r.public_token, r.amount_minor, r.currency, r.description, r.status, r.expires_at, r.is_sandbox, r.qr_payload, r.provider_order_id, m.display_name AS merchant_name
         FROM payment_requests r JOIN merchants m ON m.id = r.merchant_id WHERE r.public_token=$1`,
      [token],
    );
    if (!r) throw new DomainError('NOT_FOUND', 'Payment link not found', 404);
    return {
      merchantName: r.merchant_name,
      amountMinor: r.amount_minor,
      currency: r.currency,
      description: r.description,
      // PAID is shown only after backend verification; a customer-side "success" never changes this.
      status: r.status === 'PAID' ? 'PAID' : r.status === 'PENDING' ? 'AWAITING_PAYMENT' : r.status,
      expiresAt: r.expires_at,
      sandbox: r.is_sandbox,
      qrPayload: r.qr_payload,
      // Only for the simulator's checkout buttons; real providers never expose this.
      sandboxOrderId: r.is_sandbox ? r.provider_order_id : undefined,
    };
  }
}
