import { createHash } from 'crypto';
import { ProviderRejection } from '../../common/errors';
import { ParsedWebhook, ProviderOrder, ProviderPayment, ProviderPaymentStatus, ProviderRefund } from '../provider';
import { call, FetchLike, rupees, toMinor } from './http';
import { HostedGatewayProvider, notFound } from './hosted.base';
import { generateSignature, verifySignature } from './paytm-checksum';

export interface PaytmOptions {
  mid: string;
  merchantKey: string;
  website: string;
  /** Must be Paytm's staging host. Production is refused (live mode is blocked platform-wide). */
  baseUrl: string;
  publicBaseUrl: string;
  /** Resolves OUR merchant for an order id from our own payment_requests row (Paytm's status API does not echo a merchant reference). */
  resolveMerchantRef: (orderId: string) => Promise<string | null>;
  fetch?: FetchLike;
}

/**
 * Paytm Payment Gateway (Initiate Transaction + Show Payment Page, status via /v3/order/status, refunds via /refund/apply).
 * Requests are signed with Paytm's checksum; the callback / server-to-server notification carries CHECKSUMHASH which is verified here.
 * orderId == provider order id == provider payment id.
 */
export class PaytmProvider extends HostedGatewayProvider {
  readonly name = 'paytm';
  readonly isSandbox = true;
  private readonly base: string;
  private readonly f: FetchLike;

  constructor(private readonly o: PaytmOptions) {
    super();
    if (!/stage|staging|localhost|127\.0\.0\.1/.test(o.baseUrl)) throw new Error('Only the Paytm staging host is accepted; production is blocked until the live-mode checklist is complete');
    this.base = o.baseUrl.replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>) {
    const json = JSON.stringify(body);
    const signature = generateSignature(json, this.o.merchantKey);
    // Paytm verifies the checksum over the exact body string, so the same string is sent.
    const raw = `{"body":${json},"head":{"signature":${JSON.stringify(signature)}}}`;
    return call(this.f, this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  }

  async createOrder(i: Parameters<HostedGatewayProvider['createOrder']>[0]): Promise<ProviderOrder> {
    if (i.currency !== 'INR') throw new ProviderRejection('UNSUPPORTED_CURRENCY', 'Paytm collects INR only');
    const orderId = 'GW' + i.referenceId.replace(/-/g, '');
    const r = await this.post(`/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(this.o.mid)}&orderId=${orderId}`, {
      requestType: 'Payment',
      mid: this.o.mid,
      websiteName: this.o.website,
      orderId,
      callbackUrl: `${this.o.publicBaseUrl}/pay/done`,
      txnAmount: { value: rupees(i.amountMinor), currency: 'INR' },
      userInfo: { custId: ('C' + i.merchantRef.replace(/[^A-Za-z0-9]/g, '')).slice(0, 64) },
    });
    const info = r.json?.body?.resultInfo;
    const token = r.json?.body?.txnToken;
    if (r.status !== 200 || info?.resultStatus !== 'S' || typeof token !== 'string') {
      throw new ProviderRejection(String(info?.resultCode ?? `HTTP_${r.status}`), String(info?.resultMsg ?? 'Paytm refused the request'));
    }
    // The token is short-lived and only valid for this order; it travels in the query string to our own checkout page.
    const url = `${this.o.publicBaseUrl}/pay/${this.name}/${orderId}?t=${encodeURIComponent(token)}`;
    return { providerOrderId: orderId, checkoutUrl: url, qrPayload: url };
  }

  private static status(resultStatus: string, refunded: number, amount: number): ProviderPaymentStatus {
    if (resultStatus === 'TXN_SUCCESS') return refunded > 0 && refunded >= amount ? 'refunded' : 'captured';
    if (resultStatus === 'TXN_FAILURE') return 'failed';
    return 'pending';
  }

  private async status(orderId: string) {
    const r = await this.post('/v3/order/status', { mid: this.o.mid, orderId });
    const info = r.json?.body?.resultInfo;
    if (info?.resultStatus === 'NO_RECORD_FOUND' || String(info?.resultCode) === '334') throw notFound(`payment ${orderId}`);
    if (r.status !== 200 || !info) throw new ProviderRejection(String(info?.resultCode ?? `HTTP_${r.status}`), String(info?.resultMsg ?? 'Paytm status check refused'));
    return r.json.body;
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const b = await this.status(id);
    const amount = toMinor(b.txnAmount);
    const refunded = toMinor(b.refundAmt);
    const merchantRef = (await this.o.resolveMerchantRef(id)) ?? '';
    return { id, orderId: id, amountMinor: amount, currency: 'INR', status: PaytmProvider.status(b.resultInfo.resultStatus, refunded, amount), merchantRef, refundedMinor: refunded };
  }

  /** Callback / notification: form-encoded parameters including CHECKSUMHASH over all the others. `signature` (header) is unused. */
  verifyWebhook(rawBody: string, _signature?: string): boolean {
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const checksum = params.CHECKSUMHASH;
    if (!checksum) return false;
    delete params.CHECKSUMHASH;
    return verifySignature(params, this.o.merchantKey, checksum);
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const p = Object.fromEntries(new URLSearchParams(rawBody));
    if (!p.ORDERID) throw new Error('malformed webhook');
    const status = String(p.STATUS ?? 'unknown');
    return { eventId: `${p.ORDERID}:${status}:${p.TXNID ?? ''}`, type: `payment.${status.toLowerCase()}`, providerPaymentId: p.ORDERID, providerOrderId: p.ORDERID };
  }

  async createRefund(i: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund> {
    const s = await this.status(i.providerPaymentId);
    if (s.resultInfo.resultStatus !== 'TXN_SUCCESS' || !s.txnId) throw new ProviderRejection('NOT_REFUNDABLE', 'Paytm payment is not in a refundable state');
    // refId is Paytm's own refund idempotency handle: the same key always maps to the same refId.
    const refId = 'RF' + createHash('sha256').update(i.idempotencyKey).digest('hex').slice(0, 30);
    const r = await this.post('/refund/apply', { mid: this.o.mid, txnType: 'REFUND', orderId: i.providerPaymentId, txnId: s.txnId, refId, refundAmount: rupees(i.amountMinor) });
    const info = r.json?.body?.resultInfo;
    if (r.status !== 200 || !info) throw new ProviderRejection(`HTTP_${r.status}`, 'Paytm refund call refused');
    const base = { id: String(r.json.body.refundId ?? refId), paymentId: i.providerPaymentId, amountMinor: i.amountMinor };
    if (info.resultStatus === 'TXN_SUCCESS') return { ...base, status: 'processed' };
    if (info.resultStatus === 'PENDING' || String(info.resultCode) === '617') return { ...base, status: 'pending' }; // 617: this refId was already accepted
    throw new ProviderRejection(String(info.resultCode), String(info.resultMsg ?? 'Paytm refused the refund'));
  }

  async listPayments(): Promise<ProviderPayment[]> {
    return this.noReportApi();
  }

  async renderCheckoutPage(orderId: string, query: Record<string, string>) {
    const token = query.t;
    if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) throw notFound(`checkout token for ${orderId}`);
    const action = `${this.base}/theia/api/v1/showPaymentPage?mid=${encodeURIComponent(this.o.mid)}&orderId=${encodeURIComponent(orderId)}`;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Pay</title>
<style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 16px}button{font:inherit;padding:10px 16px}.t{background:#fff3cd;padding:8px 12px;border-radius:6px}</style>
<p class=t>TEST MODE - Paytm staging payment, no real money moves.</p><h1>Continue to Paytm</h1>
<form method=post action="${esc(action)}"><input type=hidden name=mid value="${esc(this.o.mid)}"><input type=hidden name=orderId value="${esc(orderId)}"><input type=hidden name=txnToken value="${esc(token)}">
<button type=submit>Pay with Paytm</button></form>`;
    return { html, csp: `default-src 'none'; style-src 'unsafe-inline'; form-action ${this.base}` };
  }
}
