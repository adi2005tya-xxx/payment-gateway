import { randomBytes } from 'crypto';
import { ProviderRejection } from '../common/errors';
import { Db } from '../db/db';
import { PaymentProvider, ParsedWebhook, ProviderOrder, ProviderPayment, ProviderPayout, ProviderRefund } from './provider';

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Evidence-from-bank-email "provider". Orders are UPI QR/links for the payee UPI ID entered by the operator, each with a unique
 * order id in the UPI reference fields. "Payments" are bank_credits rows created ONLY from authenticated bank alert emails (or
 * dual-controlled, labelled manual attestations). There is no webhook, no payout and no refund capability: this mode confirms
 * receipts; it does not move money and enables no merchant settlement. It stays in sandbox mode (is_sandbox = true).
 */
export class BankEmailProvider implements PaymentProvider {
  readonly name = 'bank-email';
  readonly isSandbox = true;
  readonly supportsPayeeVpa = true;

  constructor(
    private readonly db: Db,
    private readonly baseUrl: string,
    readonly defaultOrderExpiryMinutes = 60,
    readonly orderExpiryGraceMinutes = 60,
  ) {}

  async createOrder(i: Parameters<PaymentProvider['createOrder']>[0]): Promise<ProviderOrder> {
    if (!i.payeeVpa) throw new ProviderRejection('PAYEE_REQUIRED', 'A payee UPI ID is required for bank-email orders');
    const orderId = 'GW' + Array.from(randomBytes(10), (b) => B32[b % B32.length]).join('');
    const q = new URLSearchParams({ pa: i.payeeVpa, pn: i.merchantName.slice(0, 40), am: (i.amountMinor / 100).toFixed(2), cu: i.currency, tr: orderId, tn: `Order ${orderId}` });
    // The checkout page is the web app's /pay/<public token>; the token is created by the caller, so no URL is returned here.
    return { providerOrderId: orderId, checkoutUrl: '', qrPayload: `upi://pay?${q.toString()}` };
  }

  /** Reads the evidence row. Never reaches out to any external system. */
  async getPayment(reference: string): Promise<ProviderPayment> {
    const [c] = await this.db.query<any>(
      `SELECT c.reference, c.amount_minor, c.currency, o.provider_order_id, o.merchant_id
         FROM bank_credits c LEFT JOIN payment_requests o ON o.id = c.order_id WHERE c.reference=$1`,
      [reference],
    );
    if (!c) throw new Error(`NOT_FOUND credit ${reference}`);
    return { id: c.reference, orderId: c.provider_order_id ?? '', amountMinor: Number(c.amount_minor), currency: c.currency.trim(), status: 'captured', merchantRef: c.merchant_id ?? '', refundedMinor: 0 };
  }

  verifyWebhook(): boolean {
    return false; // there is no webhook in this mode
  }
  parseWebhook(): ParsedWebhook {
    throw new Error('bank-email mode has no webhooks');
  }

  async createRefund(): Promise<ProviderRefund> {
    throw new ProviderRejection('NOT_SUPPORTED', 'Refunds are not available in bank-email mode; refund outside this system and record it');
  }
  async createPayout(): Promise<ProviderPayout> {
    throw new ProviderRejection('PAYOUTS_DISABLED', 'Payouts are disabled in bank-email mode');
  }
  async getPayoutByReference(): Promise<ProviderPayout | null> {
    return null;
  }
  async listPayouts(): Promise<ProviderPayout[]> {
    return [];
  }

  /** Every credit that has been applied (or is being held) is "captured"; credits not yet processed ('NEW') are excluded. */
  async listPayments(): Promise<ProviderPayment[]> {
    const rows = await this.db.query<any>(
      `SELECT c.reference, c.amount_minor, c.currency, o.provider_order_id, o.merchant_id
         FROM bank_credits c LEFT JOIN payment_requests o ON o.id = c.order_id WHERE c.status <> 'NEW' ORDER BY c.created_at`,
    );
    return rows.map((c) => ({ id: c.reference, orderId: c.provider_order_id ?? '', amountMinor: Number(c.amount_minor), currency: c.currency.trim(), status: 'captured' as const, merchantRef: c.merchant_id ?? '', refundedMinor: 0 }));
  }
}
