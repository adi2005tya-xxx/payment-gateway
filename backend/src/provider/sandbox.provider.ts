import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { TransientError } from '../common/errors';
import {
  ParsedWebhook,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderPayout,
  ProviderPayoutStatus,
  ProviderRefund,
} from './provider';

export type PayoutBehavior =
  | 'success'
  | 'fail'
  | 'processing' // accepted, stays processing until settlePayout()
  | 'timeout_after_accept' // provider created the payout, but our call times out
  | 'timeout_before_accept'; // provider never saw it

/**
 * Simulated provider. Everything it produces is test data. It exists to exercise the platform's
 * verification/payout logic, never to represent real money.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name: string;
  readonly isSandbox = true;

  protected orders = new Map<string, { referenceId: string; merchantRef: string; amountMinor: number; currency: string }>();
  protected payments = new Map<string, ProviderPayment>();
  protected payouts = new Map<string, ProviderPayout>();
  protected payoutsByKey = new Map<string, ProviderPayout>();
  protected refundsByKey = new Map<string, ProviderRefund>();

  payoutBehavior: PayoutBehavior = 'success';
  /** When true, getPayment/getPayoutByReference throw TransientError (provider outage). */
  outage = false;
  payoutCreateCalls = 0;

  constructor(protected readonly webhookSecret: string, protected readonly baseUrl = 'http://localhost:3001', name = 'sandbox') {
    this.name = name;
  }

  // ---------------------------------------------------------------- PaymentProvider
  async createOrder(i: Parameters<PaymentProvider['createOrder']>[0]): Promise<ProviderOrder> {
    const providerOrderId = `order_sbx_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.orders.set(providerOrderId, { referenceId: i.referenceId, merchantRef: i.merchantRef, amountMinor: i.amountMinor, currency: i.currency });
    return {
      providerOrderId,
      checkoutUrl: `${this.baseUrl}/pay/sandbox/${providerOrderId}`,
      // Sandbox QR payload: a link to the sandbox checkout. Real UPI payloads must come from the provider.
      qrPayload: `${this.baseUrl}/pay/sandbox/${providerOrderId}`,
    };
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    if (this.outage) throw new TransientError('sandbox provider outage');
    const p = this.payments.get(id);
    if (!p) throw new Error(`NOT_FOUND payment ${id}`);
    return { ...p };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const j = JSON.parse(rawBody);
    if (!j || typeof j.id !== 'string' || typeof j.type !== 'string') throw new Error('malformed webhook');
    return { eventId: j.id, type: j.type, providerPaymentId: j.paymentId, providerOrderId: j.orderId };
  }

  async createRefund(i: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund> {
    const existing = this.refundsByKey.get(i.idempotencyKey);
    if (existing) return existing;
    const p = this.payments.get(i.providerPaymentId);
    if (!p || p.status !== 'captured' && p.status !== 'refunded') throw new Error('payment not refundable');
    if (p.refundedMinor + i.amountMinor > p.amountMinor) throw new Error('refund exceeds payment');
    p.refundedMinor += i.amountMinor;
    if (p.refundedMinor === p.amountMinor) p.status = 'refunded';
    const r: ProviderRefund = { id: `rfnd_sbx_${randomUUID().slice(0, 8)}`, paymentId: p.id, amountMinor: i.amountMinor, status: 'processed' };
    this.refundsByKey.set(i.idempotencyKey, r);
    return r;
  }

  async createPayout(i: Parameters<PaymentProvider['createPayout']>[0]): Promise<ProviderPayout> {
    this.payoutCreateCalls++;
    const existing = this.payoutsByKey.get(i.idempotencyKey);
    if (existing) return { ...existing }; // provider-side idempotency
    if (this.payoutBehavior === 'timeout_before_accept') throw new TransientError('timeout before provider accepted payout');
    const status: ProviderPayoutStatus =
      this.payoutBehavior === 'fail' ? 'failed' : this.payoutBehavior === 'processing' ? 'processing' : 'processed';
    const p: ProviderPayout = { id: `pout_sbx_${randomUUID().slice(0, 8)}`, referenceId: i.referenceId, amountMinor: i.amountMinor, currency: i.currency, status };
    this.payouts.set(p.id, p);
    this.payoutsByKey.set(i.idempotencyKey, p);
    if (this.payoutBehavior === 'timeout_after_accept') throw new TransientError('timeout after provider accepted payout');
    return { ...p };
  }

  async getPayoutByReference(referenceId: string): Promise<ProviderPayout | null> {
    if (this.outage) throw new TransientError('sandbox provider outage');
    for (const p of this.payouts.values()) if (p.referenceId === referenceId) return { ...p };
    return null;
  }

  async listPayments(): Promise<ProviderPayment[]> {
    return [...this.payments.values()].map((p) => ({ ...p }));
  }

  async listPayouts(): Promise<ProviderPayout[]> {
    return [...this.payouts.values()].map((p) => ({ ...p }));
  }

  // ---------------------------------------------------------------- simulation controls (sandbox only)
  /** Simulates a customer attempting payment at the sandbox checkout and returns the signed webhook the provider would send. */
  simulateCustomerPayment(
    providerOrderId: string,
    opts: { outcome?: 'captured' | 'failed' | 'pending'; amountMinor?: number; merchantRef?: string } = {},
  ) {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new Error('unknown sandbox order');
    const payment: ProviderPayment = {
      id: `pay_sbx_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      orderId: providerOrderId,
      amountMinor: opts.amountMinor ?? order.amountMinor,
      currency: order.currency,
      status: opts.outcome ?? 'captured',
      merchantRef: opts.merchantRef ?? order.merchantRef,
      refundedMinor: 0,
    };
    this.payments.set(payment.id, payment);
    return { payment, webhook: this.signedWebhook(payment.status === 'captured' ? 'payment.captured' : 'payment.failed', payment) };
  }

  /** Builds a correctly signed webhook (new event id each call unless eventId given). */
  signedWebhook(type: string, payment: ProviderPayment, eventId: string = `evt_sbx_${randomUUID().slice(0, 12)}`) {
    const body = JSON.stringify({ id: eventId, type, paymentId: payment.id, orderId: payment.orderId });
    return { body, signature: createHmac('sha256', this.webhookSecret).update(body).digest('hex'), eventId };
  }

  /** Test hook: change what the provider reports for a payment (e.g. chargeback/reversal). */
  setPaymentStatus(id: string, status: ProviderPayment['status']) {
    const p = this.payments.get(id);
    if (p) p.status = status;
  }

  settlePayout(id: string, status: ProviderPayoutStatus) {
    const p = this.payouts.get(id);
    if (p) p.status = status;
  }

  /** Test hook: inject a payment the platform never heard about (for reconciliation tests). */
  injectOrphanPayment(p: ProviderPayment) {
    this.payments.set(p.id, p);
  }
}
