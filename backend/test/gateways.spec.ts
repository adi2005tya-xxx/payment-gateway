import { createHash, createHmac } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { TransientError, ProviderRejection } from '../src/common/errors';
import { createPlatform } from '../src/platform';
import { PaytmProvider } from '../src/provider/gateways/paytm.provider';
import { generateSignature, verifySignature } from '../src/provider/gateways/paytm-checksum';
import { PhonePeProvider } from '../src/provider/gateways/phonepe.provider';
import { RazorpayProvider } from '../src/provider/gateways/razorpay.provider';
import { Ctx, createRequest, seedMerchant, setup } from './helpers';

interface Call { method: string; url: string; headers: IncomingMessage['headers']; body: string }
type Handler = (c: Call) => { status?: number; json?: unknown };

/** A real local HTTP server standing in for the provider, so adapters make genuine HTTP calls. */
async function mock(handler: Handler) {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const c = { method: req.method!, url: req.url!, headers: req.headers, body };
      calls.push(c);
      const out = handler(c);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const PUBLIC = 'http://localhost:3001';

// ------------------------------------------------------------------ Razorpay
describe('Razorpay adapter', () => {
  const KEY = 'rzp_test_abc123', SECRET = 'secret_xyz', WH = 'whsec_test_123456';
  const basic = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const orders = new Map<string, any>();
  const payments = new Map<string, any>();
  const refunds: any[] = [];
  let m: Awaited<ReturnType<typeof mock>>;
  let rp: RazorpayProvider;

  beforeEach(async () => {
    orders.clear(); payments.clear(); refunds.length = 0;
    m = await mock((c) => {
      if (c.headers.authorization !== basic) return { status: 401, json: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } };
      const u = new URL(c.url, 'http://x');
      if (c.method === 'POST' && u.pathname === '/v1/orders') {
        const b = JSON.parse(c.body);
        const o = { id: `order_${orders.size + 1}`, amount: b.amount, currency: b.currency, receipt: b.receipt, notes: b.notes };
        orders.set(o.id, o);
        return { json: o };
      }
      const mo = u.pathname.match(/^\/v1\/orders\/(.+)$/);
      if (mo) return orders.has(mo[1]) ? { json: orders.get(mo[1]) } : { status: 404, json: { error: { description: 'not found' } } };
      if (u.pathname === '/v1/payments') return { json: { items: [...payments.values()] } };
      const mr = u.pathname.match(/^\/v1\/payments\/([^/]+)\/refunds?$/);
      if (mr && c.method === 'GET') return { json: { items: refunds.filter((r) => r.payment_id === mr[1]) } };
      if (mr && c.method === 'POST') {
        const b = JSON.parse(c.body);
        const r = { id: `rfnd_${refunds.length + 1}`, payment_id: mr[1], amount: b.amount, status: 'processed', notes: b.notes };
        refunds.push(r);
        payments.get(mr[1]).amount_refunded += b.amount;
        return { json: r };
      }
      const mp = u.pathname.match(/^\/v1\/payments\/([^/]+)$/);
      if (mp) return payments.has(mp[1]) ? { json: payments.get(mp[1]) } : { status: 400, json: { error: { description: 'The id provided does not exist' } } };
      return { status: 404, json: {} };
    });
    rp = new RazorpayProvider({ keyId: KEY, keySecret: SECRET, webhookSecret: WH, publicBaseUrl: PUBLIC, apiBase: m.url });
  });
  afterEach(() => m.close());

  const order = (amount = 50_000) => rp.createOrder({ referenceId: 'ref-1', merchantRef: 'merchant-1', amountMinor: amount, currency: 'INR', merchantName: 'T' });
  const pay = (orderId: string, status = 'captured', amount = 50_000) => {
    const p = { id: `pay_${payments.size + 1}`, order_id: orderId, amount, currency: 'INR', status, amount_refunded: 0 };
    payments.set(p.id, p);
    return p;
  };
  const signed = (event: string, p: any) => {
    const body = JSON.stringify({ event, created_at: 1700000000, payload: { payment: { entity: { id: p.id, order_id: p.order_id } } } });
    return { body, sig: createHmac('sha256', WH).update(body).digest('hex') };
  };

  it('refuses live keys', () => {
    expect(() => new RazorpayProvider({ keyId: 'rzp_live_x', keySecret: 's', webhookSecret: 'w', publicBaseUrl: PUBLIC })).toThrow(/TEST keys/);
  });

  it('creates an order with auth, amount and our merchant reference in notes', async () => {
    const o = await order();
    expect(o.providerOrderId).toBe('order_1');
    expect(o.checkoutUrl).toBe(`${PUBLIC}/pay/razorpay/order_1`);
    expect(orders.get('order_1')).toMatchObject({ amount: 50_000, currency: 'INR', notes: { merchantRef: 'merchant-1' } });
  });

  it('maps payment status and takes the merchant from the order notes', async () => {
    const o = await order();
    const p = pay(o.providerOrderId);
    expect(await rp.getPayment(p.id)).toMatchObject({ status: 'captured', amountMinor: 50_000, merchantRef: 'merchant-1', orderId: 'order_1', refundedMinor: 0 });
    payments.get(p.id).status = 'authorized';
    expect((await rp.getPayment(p.id)).status).toBe('pending');
    payments.get(p.id).status = 'failed';
    expect((await rp.getPayment(p.id)).status).toBe('failed');
    await expect(rp.getPayment('pay_nope')).rejects.toThrow(/NOT_FOUND/);
  });

  it('verifies webhook signatures and parses events', () => {
    const w = signed('payment.captured', { id: 'pay_9', order_id: 'order_9' });
    expect(rp.verifyWebhook(w.body, w.sig)).toBe(true);
    expect(rp.verifyWebhook(w.body + ' ', w.sig)).toBe(false);
    expect(rp.verifyWebhook(w.body, 'deadbeef')).toBe(false);
    expect(rp.verifyWebhook(w.body, undefined)).toBe(false);
    expect(rp.parseWebhook(w.body)).toMatchObject({ type: 'payment.captured', providerPaymentId: 'pay_9', providerOrderId: 'order_9' });
  });

  it('refunds idempotently: a retry with the same key does not refund twice', async () => {
    const o = await order();
    const p = pay(o.providerOrderId);
    const a = await rp.createRefund({ providerPaymentId: p.id, amountMinor: 10_000, idempotencyKey: 'k1' });
    const b = await rp.createRefund({ providerPaymentId: p.id, amountMinor: 10_000, idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(refunds).toHaveLength(1);
    expect((await rp.getPayment(p.id)).refundedMinor).toBe(10_000);
  });

  it('classifies failures: 4xx is a definitive rejection, outage is transient', async () => {
    const bad = new RazorpayProvider({ keyId: KEY, keySecret: 'wrong', webhookSecret: WH, publicBaseUrl: PUBLIC, apiBase: m.url });
    await expect(bad.createOrder({ referenceId: 'r', merchantRef: 'm', amountMinor: 100, currency: 'INR', merchantName: 'T' })).rejects.toBeInstanceOf(ProviderRejection);
    await m.close();
    await expect(order()).rejects.toBeInstanceOf(TransientError);
    m = await mock(() => ({ status: 503 })); // so afterEach can close
  });

  it('verifies the checkout return signature HMAC(order|payment, key secret)', () => {
    const sig = createHmac('sha256', SECRET).update('order_1|pay_1').digest('hex');
    expect(rp.verifyCheckoutReturn({ orderId: 'order_1', paymentId: 'pay_1', signature: sig })).toBe(true);
    expect(rp.verifyCheckoutReturn({ orderId: 'order_1', paymentId: 'pay_2', signature: sig })).toBe(false);
    expect(rp.verifyCheckoutReturn({ orderId: 'order_1', paymentId: 'pay_1', signature: 'abc' })).toBe(false);
  });

  it('checkout page has the modal, failure and dismiss handling and no secret', async () => {
    const o = await order();
    const page = await rp.renderCheckoutPage(o.providerOrderId);
    expect(page.html).toContain('payment.failed');
    expect(page.html).toContain('ondismiss');
    expect(page.html).toContain('/pay/razorpay/verify');
    expect(page.html).toContain(KEY);
    expect(page.html).not.toContain(SECRET);
  });

  it('refuses payouts instead of faking them', async () => {
    await expect(rp.createPayout()).rejects.toMatchObject({ code: 'PAYOUTS_UNSUPPORTED' });
  });

  describe('through the whole platform', () => {
    let ctx: Ctx;
    beforeEach(async () => { ctx = await setup(); });
    afterEach(() => ctx.db.close());

    it('webhook -> status lookup -> verified payment -> ledger, with the real adapter', async () => {
      const p = createPlatform(ctx.db, rp, ctx.security);
      const c = { ...ctx, p } as Ctx;
      const merchant = await seedMerchant(c);
      const req = await createRequest(c, merchant, 50_000);
      expect(req.provider).toBe('razorpay');
      expect(req.checkoutUrl).toContain('/pay/razorpay/order_');
      const rzpPay = pay(req.provider_order_id);

      const w = signed('payment.captured', rzpPay);
      await p.verification.ingestWebhook(w.body, w.sig);
      await p.jobs.drain(p.handlers);
      const [row] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [rzpPay.id]);
      expect(row).toMatchObject({ status: 'SUCCEEDED', provider: 'razorpay', is_sandbox: true });
      expect(Number(row.amount_minor)).toBe(50_000);

      // Redelivery of the same event is a no-op.
      expect((await p.verification.ingestWebhook(w.body, w.sig)).duplicate).toBe(true);

      // A forged webhook is rejected and stores nothing new.
      await expect(p.verification.ingestWebhook(w.body, 'forged')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    });

    it('a customer paying the wrong amount is held for review, not credited', async () => {
      const p = createPlatform(ctx.db, rp, ctx.security);
      const c = { ...ctx, p } as Ctx;
      const merchant = await seedMerchant(c);
      const req = await createRequest(c, merchant, 50_000);
      const underpaid = pay(req.provider_order_id, 'captured', 40_000);
      const w = signed('payment.captured', underpaid);
      await p.verification.ingestWebhook(w.body, w.sig);
      await p.jobs.drain(p.handlers);
      const [row] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [underpaid.id]);
      expect(row.status).toBe('UNDER_REVIEW');
      expect(row.verification_result).toContain('AMOUNT_MISMATCH');
    });
  });
});

// ------------------------------------------------------------------ PhonePe
describe('PhonePe adapter', () => {
  const SALT = 'salt-key-test', IDX = '1', MID = 'MERCHANTUAT';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const txns = new Map<string, any>();
  const owners = new Map<string, string>();
  let m: Awaited<ReturnType<typeof mock>>;
  let pp: PhonePeProvider;

  beforeEach(async () => {
    txns.clear(); owners.clear();
    m = await mock((c) => {
      if (c.method === 'POST' && c.url === '/pg/v1/pay') {
        const { request } = JSON.parse(c.body);
        if (c.headers['x-verify'] !== `${sha(request + '/pg/v1/pay' + SALT)}###${IDX}`) return { status: 401, json: { success: false, code: 'AUTHORIZATION_FAILED', message: 'bad checksum' } };
        const p = JSON.parse(Buffer.from(request, 'base64').toString());
        txns.set(p.merchantTransactionId, { amount: p.amount, state: 'PENDING', code: 'PAYMENT_PENDING' });
        return { json: { success: true, code: 'PAYMENT_INITIATED', data: { instrumentResponse: { redirectInfo: { url: `https://mercury-uat.phonepe.com/transact/${p.merchantTransactionId}` } } } } };
      }
      const ms = c.url.match(/^\/pg\/v1\/status\/([^/]+)\/([^/]+)$/);
      if (ms) {
        if (c.headers['x-verify'] !== `${sha(c.url + SALT)}###${IDX}`) return { status: 401, json: { success: false, code: 'AUTHORIZATION_FAILED' } };
        const t = txns.get(ms[2]);
        return t ? { json: { success: t.code === 'PAYMENT_SUCCESS', code: t.code, data: { merchantTransactionId: ms[2], amount: t.amount, state: t.state } } } : { status: 404, json: { success: false, code: 'TRANSACTION_NOT_FOUND' } };
      }
      return { status: 404 };
    });
    pp = new PhonePeProvider({ merchantId: MID, saltKey: SALT, saltIndex: IDX, baseUrl: m.url, publicBaseUrl: PUBLIC, resolveMerchantRef: async (id) => owners.get(id) ?? null });
  });
  afterEach(() => m.close());

  const make = async (amount = 25_000) => {
    const o = await pp.createOrder({ referenceId: 'aaaa-bbbb-cccc', merchantRef: 'm-1', amountMinor: amount, currency: 'INR', merchantName: 'T' });
    owners.set(o.providerOrderId, 'm-1');
    return o;
  };
  const callback = (txn: string, state: string) => {
    const response = Buffer.from(JSON.stringify({ success: state === 'COMPLETED', code: 'X', data: { merchantTransactionId: txn, state } })).toString('base64');
    return { body: JSON.stringify({ response }), sig: `${sha(response + SALT)}###${IDX}` };
  };

  it('refuses production hosts', () => {
    expect(() => new PhonePeProvider({ merchantId: MID, saltKey: SALT, saltIndex: IDX, baseUrl: 'https://api.phonepe.com/apis/hermes', publicBaseUrl: PUBLIC, resolveMerchantRef: async () => null })).toThrow(/sandbox/);
  });

  it('creates a signed order and returns the hosted payment page', async () => {
    const o = await make();
    expect(o.providerOrderId).toBe('GWaaaabbbbcccc');
    expect(o.checkoutUrl).toContain('phonepe.com/transact/GWaaaabbbbcccc');
    expect(txns.get(o.providerOrderId).amount).toBe(25_000);
  });

  it('rejects non-INR and a bad checksum', async () => {
    await expect(pp.createOrder({ referenceId: 'x', merchantRef: 'm', amountMinor: 100, currency: 'USD', merchantName: 'T' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
    const wrong = new PhonePeProvider({ merchantId: MID, saltKey: 'wrong', saltIndex: IDX, baseUrl: m.url, publicBaseUrl: PUBLIC, resolveMerchantRef: async () => null });
    await expect(wrong.createOrder({ referenceId: 'x', merchantRef: 'm', amountMinor: 100, currency: 'INR', merchantName: 'T' })).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
  });

  it('maps status, attributes by our own order record, treats unknown as not found', async () => {
    const o = await make();
    expect((await pp.getPayment(o.providerOrderId)).status).toBe('pending');
    Object.assign(txns.get(o.providerOrderId), { state: 'COMPLETED', code: 'PAYMENT_SUCCESS' });
    expect(await pp.getPayment(o.providerOrderId)).toMatchObject({ status: 'captured', amountMinor: 25_000, merchantRef: 'm-1', currency: 'INR' });
    Object.assign(txns.get(o.providerOrderId), { state: 'FAILED', code: 'PAYMENT_ERROR' });
    expect((await pp.getPayment(o.providerOrderId)).status).toBe('failed');
    await expect(pp.getPayment('GWnope')).rejects.toThrow(/NOT_FOUND/);
  });

  it('verifies the signed callback and parses it', async () => {
    const w = callback('GWabc', 'COMPLETED');
    expect(pp.verifyWebhook(w.body, w.sig)).toBe(true);
    expect(pp.verifyWebhook(w.body, 'x###1')).toBe(false);
    expect(pp.verifyWebhook(w.body, undefined)).toBe(false);
    expect(pp.verifyWebhook('not json', w.sig)).toBe(false);
    expect(pp.parseWebhook(w.body)).toMatchObject({ type: 'payment.completed', providerPaymentId: 'GWabc' });
  });

  it('says plainly what it cannot do', async () => {
    await expect(pp.createRefund()).rejects.toMatchObject({ code: 'REFUNDS_UNSUPPORTED' });
    await expect(pp.listPayments()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', status: 501 });
    await expect(pp.createPayout()).rejects.toMatchObject({ code: 'PAYOUTS_UNSUPPORTED' });
  });

  it('end to end through the platform', async () => {
    const ctx = await setup();
    try {
      const p = createPlatform(ctx.db, new PhonePeProvider({ merchantId: MID, saltKey: SALT, saltIndex: IDX, baseUrl: m.url, publicBaseUrl: PUBLIC,
        resolveMerchantRef: async (id) => (await ctx.db.query<any>('SELECT merchant_id FROM payment_requests WHERE provider_order_id=$1', [id]))[0]?.merchant_id ?? null }), ctx.security);
      const c = { ...ctx, p } as Ctx;
      const merchant = await seedMerchant(c);
      const req = await createRequest(c, merchant, 25_000);
      Object.assign(txns.get(req.provider_order_id), { state: 'COMPLETED', code: 'PAYMENT_SUCCESS' });
      const w = callback(req.provider_order_id, 'COMPLETED');
      await p.verification.ingestWebhook(w.body, w.sig);
      await p.jobs.drain(p.handlers);
      const [row] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [req.provider_order_id]);
      expect(row).toMatchObject({ status: 'SUCCEEDED', provider: 'phonepe' });
      // Post-restore sweep must not crash on a provider with no report API.
      await expect(p.provider.listPayments()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    } finally {
      await ctx.db.close();
    }
  });
});

// ------------------------------------------------------------------ Paytm
describe('Paytm adapter', () => {
  const KEY = '0123456789abcdef', MID = 'TESTMID0000001';
  const orders = new Map<string, any>();
  const owners = new Map<string, string>();
  const refundsSeen = new Set<string>();
  let m: Awaited<ReturnType<typeof mock>>;
  let pt: PaytmProvider;

  beforeEach(async () => {
    orders.clear(); owners.clear(); refundsSeen.clear();
    m = await mock((c) => {
      const outer = c.body ? JSON.parse(c.body) : null;
      const rawBody = c.body.slice(c.body.indexOf('"body":') + 7, c.body.lastIndexOf(',"head"'));
      if (!outer || !verifySignature(rawBody, KEY, outer.head?.signature)) return { json: { body: { resultInfo: { resultStatus: 'F', resultCode: '330', resultMsg: 'Checksum provided is invalid' } } } };
      const u = new URL(c.url, 'http://x');
      if (u.pathname === '/theia/api/v1/initiateTransaction') {
        orders.set(outer.body.orderId, { amount: outer.body.txnAmount.value, status: 'PENDING', refunded: '0.00', txnId: 'TXN' + orders.size });
        return { json: { body: { resultInfo: { resultStatus: 'S', resultCode: '0000' }, txnToken: 'tok_' + outer.body.orderId } } };
      }
      if (u.pathname === '/v3/order/status') {
        const o = orders.get(outer.body.orderId);
        if (!o) return { json: { body: { resultInfo: { resultStatus: 'NO_RECORD_FOUND', resultCode: '334' } } } };
        return { json: { body: { resultInfo: { resultStatus: o.status }, txnAmount: o.amount, refundAmt: o.refunded, txnId: o.txnId, orderId: outer.body.orderId } } };
      }
      if (u.pathname === '/refund/apply') {
        const dup = refundsSeen.has(outer.body.refId);
        refundsSeen.add(outer.body.refId);
        if (dup) return { json: { body: { resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '617' } } } };
        orders.get(outer.body.orderId).refunded = outer.body.refundAmount;
        return { json: { body: { resultInfo: { resultStatus: 'PENDING', resultCode: '601' }, refundId: 'R' + outer.body.refId } } };
      }
      return { status: 404 };
    });
    pt = new PaytmProvider({ mid: MID, merchantKey: KEY, website: 'WEBSTAGING', baseUrl: m.url.replace('127.0.0.1', 'localhost'), publicBaseUrl: PUBLIC, resolveMerchantRef: async (id) => owners.get(id) ?? null });
  });
  afterEach(() => m.close());

  const make = async (amount = 123_456) => {
    const o = await pt.createOrder({ referenceId: 'aaaa-bbbb', merchantRef: 'm-1', amountMinor: amount, currency: 'INR', merchantName: 'T' });
    owners.set(o.providerOrderId, 'm-1');
    return o;
  };

  it('checksum round-trips and detects tampering', () => {
    const params = { MID, ORDERID: 'o1', TXNAMOUNT: '10.00', STATUS: 'TXN_SUCCESS' };
    const sig = generateSignature(params, KEY);
    expect(verifySignature(params, KEY, sig)).toBe(true);
    expect(verifySignature({ ...params, TXNAMOUNT: '99.00' }, KEY, sig)).toBe(false);
    expect(verifySignature(params, 'fedcba9876543210', sig)).toBe(false);
    expect(verifySignature(params, KEY, 'garbage')).toBe(false);
    expect(generateSignature(params, KEY)).not.toBe(generateSignature(params, KEY)); // random salt
  });

  it('refuses production hosts', () => {
    expect(() => new PaytmProvider({ mid: MID, merchantKey: KEY, website: 'W', baseUrl: 'https://secure.paytmpayments.com', publicBaseUrl: PUBLIC, resolveMerchantRef: async () => null })).toThrow(/staging/);
  });

  it('creates a signed order with rupee amount and returns our checkout URL with the token', async () => {
    const o = await make(123_456);
    expect(orders.get(o.providerOrderId).amount).toBe('1234.56');
    expect(o.checkoutUrl).toBe(`${PUBLIC}/pay/paytm/${o.providerOrderId}?t=tok_${o.providerOrderId}`);
    const page = await pt.renderCheckoutPage(o.providerOrderId, { t: `tok_${o.providerOrderId}` });
    expect(page.html).toContain('name=txnToken');
    expect(page.html).toContain('showPaymentPage');
    await expect(pt.renderCheckoutPage('x', { t: '"><script>' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('a request signed with the wrong key is refused by the provider', async () => {
    const bad = new PaytmProvider({ mid: MID, merchantKey: 'fedcba9876543210', website: 'W', baseUrl: m.url.replace('127.0.0.1', 'localhost'), publicBaseUrl: PUBLIC, resolveMerchantRef: async () => null });
    await expect(bad.createOrder({ referenceId: 'x', merchantRef: 'm', amountMinor: 100, currency: 'INR', merchantName: 'T' })).rejects.toMatchObject({ code: '330' });
  });

  it('maps status including refunds, and unknown orders', async () => {
    const o = await make(10_000);
    expect((await pt.getPayment(o.providerOrderId)).status).toBe('pending');
    orders.get(o.providerOrderId).status = 'TXN_SUCCESS';
    expect(await pt.getPayment(o.providerOrderId)).toMatchObject({ status: 'captured', amountMinor: 10_000, merchantRef: 'm-1', refundedMinor: 0 });
    orders.get(o.providerOrderId).refunded = '40.00';
    expect(await pt.getPayment(o.providerOrderId)).toMatchObject({ status: 'captured', refundedMinor: 4_000 });
    orders.get(o.providerOrderId).refunded = '100.00';
    expect((await pt.getPayment(o.providerOrderId)).status).toBe('refunded');
    orders.get(o.providerOrderId).status = 'TXN_FAILURE';
    expect((await pt.getPayment(o.providerOrderId)).status).toBe('failed');
    await expect(pt.getPayment('GWnone')).rejects.toThrow(/NOT_FOUND/);
  });

  it('verifies the checksummed notification', () => {
    const params = { MID, ORDERID: 'GWx', TXNID: 'T1', STATUS: 'TXN_SUCCESS', TXNAMOUNT: '10.00' };
    const body = new URLSearchParams({ ...params, CHECKSUMHASH: generateSignature(params, KEY) }).toString();
    expect(pt.verifyWebhook(body)).toBe(true);
    expect(pt.parseWebhook(body)).toMatchObject({ type: 'payment.txn_success', providerPaymentId: 'GWx' });
    expect(pt.verifyWebhook(body.replace('10.00', '99.00'))).toBe(false);
    expect(pt.verifyWebhook(new URLSearchParams(params).toString())).toBe(false); // no checksum
  });

  it('refunds idempotently using a deterministic refId', async () => {
    const o = await make(10_000);
    orders.get(o.providerOrderId).status = 'TXN_SUCCESS';
    const a = await pt.createRefund({ providerPaymentId: o.providerOrderId, amountMinor: 2_500, idempotencyKey: 'rk1' });
    const b = await pt.createRefund({ providerPaymentId: o.providerOrderId, amountMinor: 2_500, idempotencyKey: 'rk1' });
    expect(a.status).toBe('pending');
    expect(b.status).toBe('pending'); // provider said "already accepted"; not an error, not a second refund
    expect(refundsSeen.size).toBe(1);
  });

  it('end to end through the platform with the notification', async () => {
    const ctx = await setup();
    try {
      const prov = new PaytmProvider({ mid: MID, merchantKey: KEY, website: 'W', baseUrl: m.url.replace('127.0.0.1', 'localhost'), publicBaseUrl: PUBLIC,
        resolveMerchantRef: async (id) => (await ctx.db.query<any>('SELECT merchant_id FROM payment_requests WHERE provider_order_id=$1', [id]))[0]?.merchant_id ?? null });
      const p = createPlatform(ctx.db, prov, ctx.security);
      const c = { ...ctx, p } as Ctx;
      const merchant = await seedMerchant(c);
      const req = await createRequest(c, merchant, 75_000);
      orders.get(req.provider_order_id).status = 'TXN_SUCCESS';
      const params = { MID, ORDERID: req.provider_order_id, TXNID: 'T1', STATUS: 'TXN_SUCCESS', TXNAMOUNT: '750.00' };
      const body = new URLSearchParams({ ...params, CHECKSUMHASH: generateSignature(params, KEY) }).toString();
      await p.verification.ingestWebhook(body, undefined);
      await p.jobs.drain(p.handlers);
      const [row] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [req.provider_order_id]);
      expect(row).toMatchObject({ status: 'SUCCEEDED', provider: 'paytm' });
      expect(Number(row.amount_minor)).toBe(75_000);
      await expect(p.verification.ingestWebhook(body.replace('750.00', '1.00'), undefined)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    } finally {
      await ctx.db.close();
    }
  });
});
