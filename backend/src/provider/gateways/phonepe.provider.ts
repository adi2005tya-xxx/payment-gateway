import { createHash, timingSafeEqual } from 'crypto';
import { ProviderRejection } from '../../common/errors';
import { ParsedWebhook, ProviderOrder, ProviderPayment, ProviderPaymentStatus } from '../provider';
import { call, FetchLike } from './http';
import { HostedGatewayProvider, notFound } from './hosted.base';

export interface PhonePeOptions {
  merchantId: string;
  saltKey: string;
  saltIndex: string;
  /** Must be PhonePe's sandbox/UAT host. Production hosts are refused (live mode is blocked platform-wide). */
  baseUrl: string;
  publicBaseUrl: string;
  /** Resolves OUR merchant for an order id from our own payment_requests row (PhonePe does not echo a merchant reference on status). */
  resolveMerchantRef: (orderId: string) => Promise<string | null>;
  fetch?: FetchLike;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * PhonePe Payment Gateway, salt-key ("X-VERIFY") API: /pg/v1/pay, /pg/v1/status/{merchantId}/{txnId}, signed callback.
 * One order == one PhonePe merchantTransactionId == one payment id. Status API is the source of truth; the callback only triggers a lookup.
 * Not supported by this API, so refused rather than faked: refunds (status does not report refunded amounts, which would break reconciliation) and transaction listing.
 */
export class PhonePeProvider extends HostedGatewayProvider {
  readonly name = 'phonepe';
  readonly isSandbox = true;
  private readonly base: string;
  private readonly f: FetchLike;

  constructor(private readonly o: PhonePeOptions) {
    super();
    if (!/sandbox|preprod|localhost|127\.0\.0\.1/.test(o.baseUrl)) throw new Error('Only the PhonePe sandbox/UAT host is accepted; production is blocked until the live-mode checklist is complete');
    this.base = o.baseUrl.replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
  }

  private xVerify(payloadAndPath: string): string {
    return `${sha256(payloadAndPath + this.o.saltKey)}###${this.o.saltIndex}`;
  }

  async createOrder(i: Parameters<HostedGatewayProvider['createOrder']>[0]): Promise<ProviderOrder> {
    if (i.currency !== 'INR') throw new ProviderRejection('UNSUPPORTED_CURRENCY', 'PhonePe collects INR only');
    const txn = 'GW' + i.referenceId.replace(/-/g, ''); // <= 38 chars, [A-Za-z0-9]
    const payload = {
      merchantId: this.o.merchantId,
      merchantTransactionId: txn,
      merchantUserId: ('MU' + i.merchantRef.replace(/[^A-Za-z0-9]/g, '')).slice(0, 36),
      amount: i.amountMinor,
      redirectUrl: `${this.o.publicBaseUrl}/pay/done`,
      redirectMode: 'REDIRECT',
      callbackUrl: `${this.o.publicBaseUrl}/webhooks/${this.name}`,
      paymentInstrument: { type: 'PAY_PAGE' },
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const r = await call(this.f, `${this.base}/pg/v1/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-verify': this.xVerify(b64 + '/pg/v1/pay'), accept: 'application/json' },
      body: JSON.stringify({ request: b64 }),
    });
    const url = r.json?.data?.instrumentResponse?.redirectInfo?.url;
    if (r.status !== 200 || !r.json?.success || typeof url !== 'string') {
      throw new ProviderRejection(String(r.json?.code ?? `HTTP_${r.status}`), String(r.json?.message ?? 'PhonePe refused the request'));
    }
    return { providerOrderId: txn, checkoutUrl: url, qrPayload: url };
  }

  private static status(code: string, state: string | undefined): ProviderPaymentStatus {
    if (code === 'PAYMENT_SUCCESS' || state === 'COMPLETED') return 'captured';
    if (code === 'PAYMENT_PENDING' || state === 'PENDING') return 'pending';
    return 'failed'; // PAYMENT_ERROR, PAYMENT_DECLINED, TIMED_OUT, AUTHORIZATION_FAILED, ...
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const path = `/pg/v1/status/${encodeURIComponent(this.o.merchantId)}/${encodeURIComponent(id)}`;
    const r = await call(this.f, this.base + path, {
      method: 'GET',
      headers: { 'content-type': 'application/json', 'x-verify': this.xVerify(path), 'x-merchant-id': this.o.merchantId, accept: 'application/json' },
    });
    const code = String(r.json?.code ?? '');
    if (r.status === 404 || code === 'TRANSACTION_NOT_FOUND' || code === 'BAD_REQUEST') throw notFound(`payment ${id}`);
    if (r.status !== 200 || !r.json) throw new ProviderRejection(code || `HTTP_${r.status}`, String(r.json?.message ?? 'PhonePe status check refused'));
    const status = PhonePeProvider.status(code, r.json.data?.state);
    const merchantRef = (await this.o.resolveMerchantRef(id)) ?? '';
    return { id, orderId: id, amountMinor: Number(r.json.data?.amount ?? 0), currency: 'INR', status, merchantRef, refundedMinor: 0 };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    let response: unknown;
    try {
      response = JSON.parse(rawBody)?.response;
    } catch {
      return false;
    }
    if (typeof response !== 'string') return false;
    const expected = Buffer.from(`${sha256(response + this.o.saltKey)}###${this.o.saltIndex}`);
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const outer = JSON.parse(rawBody);
    const inner = JSON.parse(Buffer.from(String(outer.response), 'base64').toString('utf8'));
    const txn = inner?.data?.merchantTransactionId;
    if (typeof txn !== 'string') throw new Error('malformed webhook');
    const state = String(inner.data?.state ?? inner.code ?? 'unknown');
    return { eventId: `${txn}:${state}`, type: `payment.${state.toLowerCase()}`, providerPaymentId: txn, providerOrderId: txn };
  }

  async createRefund(): Promise<never> {
    throw new ProviderRejection('REFUNDS_UNSUPPORTED', 'PhonePe adapter does not support refunds yet: its status API does not report refunded amounts, so reconciliation could not verify them');
  }

  async listPayments(): Promise<ProviderPayment[]> {
    return this.noReportApi();
  }
}
