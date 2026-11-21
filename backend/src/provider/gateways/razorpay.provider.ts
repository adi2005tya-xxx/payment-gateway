import { createHmac, timingSafeEqual } from 'crypto';
import { ProviderRejection } from '../../common/errors';
import { ParsedWebhook, ProviderOrder, ProviderPayment, ProviderPaymentStatus, ProviderRefund } from '../provider';
import { call, FetchLike, jsonForScript } from './http';
import { HostedGatewayProvider, notFound } from './hosted.base';

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  publicBaseUrl: string;
  apiBase?: string;
  fetch?: FetchLike;
}

/**
 * Razorpay Orders API + Standard Checkout (https://razorpay.com/docs/api/orders/, /payments/, /refunds/).
 * Customer pays on checkout.js against an order we create; the webhook only tells us WHICH payment to look at, the amount and
 * status always come from GET /v1/payments/:id (see VerificationService).
 * Only test keys (rzp_test_...) are accepted: PAYMENT_MODE=live stays blocked platform-wide.
 */
export class RazorpayProvider extends HostedGatewayProvider {
  readonly name = 'razorpay';
  readonly isSandbox = true;
  private readonly api: string;
  private readonly f: FetchLike;

  constructor(private readonly o: RazorpayOptions) {
    super();
    if (!o.keyId.startsWith('rzp_test_')) throw new Error('Only Razorpay TEST keys (rzp_test_...) are accepted; live keys are blocked until the live-mode checklist is complete');
    this.api = (o.apiBase ?? 'https://api.razorpay.com').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
  }

  get customCheckoutKeyId(): string {
    return this.o.keyId;
  }

  async captureIfAuthorized(id: string): Promise<void> {
    const r = await this.req('GET', `/v1/payments/${encodeURIComponent(id)}`);
    if (r.status !== 200 || r.json?.status !== 'authorized') return;
    const c = await this.req('POST', `/v1/payments/${encodeURIComponent(id)}/capture`, { amount: r.json.amount, currency: r.json.currency });
    if (c.status !== 200) this.reject(c);
  }

  private headers() {
    return { authorization: 'Basic ' + Buffer.from(`${this.o.keyId}:${this.o.keySecret}`).toString('base64'), 'content-type': 'application/json' };
  }

  private req(method: string, path: string, body?: unknown) {
    return call(this.f, this.api + path, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  }

  private reject(r: { status: number; json: any }): never {
    const e = r.json?.error;
    throw new ProviderRejection(String(e?.code ?? `HTTP_${r.status}`), String(e?.description ?? 'Razorpay refused the request'));
  }

  async createOrder(i: Parameters<HostedGatewayProvider['createOrder']>[0]): Promise<ProviderOrder> {
    const r = await this.req('POST', '/v1/orders', {
      amount: i.amountMinor,
      currency: i.currency,
      receipt: i.referenceId.slice(0, 40),
      notes: { merchantRef: i.merchantRef, referenceId: i.referenceId },
    });
    if (r.status !== 200 || !r.json?.id) this.reject(r);
    const url = `${this.o.publicBaseUrl}/pay/${this.name}/${r.json.id}`;
    return { providerOrderId: r.json.id, checkoutUrl: url, qrPayload: url };
  }

  private static status(s: string, refundedMinor: number, amount: number): ProviderPaymentStatus {
    switch (s) {
      case 'captured': return refundedMinor >= amount && amount > 0 ? 'refunded' : 'captured';
      case 'refunded': return 'refunded';
      case 'failed': return 'failed';
      case 'authorized': return 'pending'; // not captured yet: never treated as money received (enable auto-capture in the dashboard)
      default: return 'created';
    }
  }

  private toPayment(p: any, merchantRef: string): ProviderPayment {
    const refunded = Number(p.amount_refunded ?? 0);
    return {
      id: p.id,
      orderId: p.order_id ?? '',
      amountMinor: Number(p.amount),
      currency: p.currency,
      status: RazorpayProvider.status(p.status, refunded, Number(p.amount)),
      merchantRef,
      refundedMinor: refunded,
    };
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const r = await this.req('GET', `/v1/payments/${encodeURIComponent(id)}`);
    if (r.status === 404 || /does not exist/i.test(r.json?.error?.description ?? '')) throw notFound(`payment ${id}`);
    if (r.status !== 200 || !r.json?.id) this.reject(r);
    // Attribution comes from the notes WE attached to the order, not from anything the customer controls.
    let merchantRef = '';
    if (r.json.order_id) {
      const o = await this.req('GET', `/v1/orders/${encodeURIComponent(r.json.order_id)}`);
      if (o.status === 200) merchantRef = String(o.json?.notes?.merchantRef ?? '');
    }
    return this.toPayment(r.json, merchantRef);
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(createHmac('sha256', this.o.webhookSecret).update(rawBody).digest('hex'));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Standard Checkout return: signature = HMAC-SHA256(order_id|payment_id, KEY_SECRET). */
  verifyCheckoutReturn(r: { orderId: string; paymentId: string; signature: string }): boolean {
    const expected = Buffer.from(createHmac('sha256', this.o.keySecret).update(`${r.orderId}|${r.paymentId}`).digest('hex'));
    const given = Buffer.from(r.signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const j = JSON.parse(rawBody);
    if (!j || typeof j.event !== 'string') throw new Error('malformed webhook');
    const pay = j.payload?.payment?.entity;
    // Razorpay's body has no event id; event + payment id + creation time is stable across its redeliveries.
    return { eventId: `${j.event}:${pay?.id ?? 'none'}:${j.created_at ?? 0}`, type: j.event === 'order.paid' ? 'payment.order_paid' : j.event, providerPaymentId: pay?.id, providerOrderId: pay?.order_id };
  }

  async createRefund(i: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }) {
    const id = encodeURIComponent(i.providerPaymentId);
    // Razorpay refunds have no idempotency header: look for our key in the payment's refunds first so a retry never refunds twice.
    const prior = await this.req('GET', `/v1/payments/${id}/refunds?count=100`);
    if (prior.status === 200) {
      const hit = (prior.json?.items ?? []).find((x: any) => x.notes?.idempotencyKey === i.idempotencyKey);
      if (hit) return this.toRefund(hit);
    }
    const r = await this.req('POST', `/v1/payments/${id}/refund`, { amount: i.amountMinor, notes: { idempotencyKey: i.idempotencyKey } });
    if (r.status !== 200 || !r.json?.id) this.reject(r);
    return this.toRefund(r.json);
  }

  private toRefund(x: any): ProviderRefund {
    return { id: x.id, paymentId: x.payment_id, amountMinor: Number(x.amount), status: x.status === 'processed' ? 'processed' : x.status === 'failed' ? 'failed' : 'pending' };
  }

  async listPayments(): Promise<ProviderPayment[]> {
    const out: ProviderPayment[] = [];
    for (let skip = 0; skip < 1000; skip += 100) {
      const r = await this.req('GET', `/v1/payments?count=100&skip=${skip}`);
      if (r.status !== 200) this.reject(r);
      const items: any[] = r.json?.items ?? [];
      out.push(...items.map((p) => this.toPayment(p, '')));
      if (items.length < 100) break;
    }
    return out;
  }

  async renderCheckoutPage(orderId: string) {
    const r = await this.req('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
    if (r.status === 404) throw notFound(`order ${orderId}`);
    if (r.status !== 200 || !r.json?.id) this.reject(r);
    const opts = { key: this.o.keyId, amount: r.json.amount, currency: r.json.currency, order_id: r.json.id, name: 'Gateway', description: 'Test mode payment' };
    const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Pay</title>
<style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 16px}button{font:inherit;padding:10px 16px}.t{background:#fff3cd;padding:8px 12px;border-radius:6px}</style>
<p class=t>TEST MODE - Razorpay test payment, no real money moves.</p><h1>Pay ${(Number(r.json.amount) / 100).toFixed(2)} ${String(r.json.currency).replace(/[^A-Z]/g, '')}</h1>
<button id=b>Pay now</button><p id=m aria-live=polite></p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>const o=${jsonForScript(opts)};const m=document.getElementById('m'),b=document.getElementById('b');
const say=t=>{m.textContent=t};
o.modal={ondismiss:()=>say('Payment cancelled. You can try again.')};
o.handler=async r=>{say('Verifying payment...');try{const v=await fetch('/pay/razorpay/verify',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({orderId:r.razorpay_order_id,paymentId:r.razorpay_payment_id,signature:r.razorpay_signature})});
say(v.ok?'Payment verified. The merchant is notified once the platform confirms it with Razorpay.':'Payment could not be verified. Do not retry; contact the merchant.');b.hidden=v.ok}catch(e){say('Network error while verifying. Your payment may still have gone through; check with the merchant.')}};
b.onclick=()=>{const z=new Razorpay(o);z.on('payment.failed',e=>say('Payment failed: '+((e&&e.error&&e.error.description)||'unknown error')+'. You can try again.'));z.open()};
</script>`;
    const csp = "default-src 'none'; script-src 'unsafe-inline' https://checkout.razorpay.com; style-src 'unsafe-inline'; frame-src https://api.razorpay.com https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://checkout.razorpay.com; img-src https: data:";
    return { html, csp };
  }
}
