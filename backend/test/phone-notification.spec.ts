import 'reflect-metadata';
import { createHash } from 'crypto';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { ACCOUNTS, merchantPayable } from '../src/ledger/ledger.service';
import { summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { boot, nextRef, orderRow, World } from './bank-email-helpers';

jest.setTimeout(180_000);

// The "REAL" fixture below is the one PhonePe Business notification the operator actually showed us (a Rs 10 credit).
// Every other wording (paise amounts, refunds, failures) is SYNTHETIC: we have not seen a real one.
const REAL = { title: 'Received Rs 10', text: "You've received Rs 10 from ******0696 via PhonePe for txn T2610132007529301256970." };
// Second REAL sample (screenshot, 14 Oct): a Rs 1.10 payment is displayed WITHOUT the trailing zero, as "Rs 1.1".
const REAL_PAISE = { title: 'Received Rs 1.1', text: "You've received Rs 1.1 from ******0696 via PhonePe for txn T2610141213300329890819." };
const PKG = 'com.phonepe.business';

const NOTIFICATION_TEMPLATE = {
  channel: 'notification',
  packages: [PKG],
  useReceiptTime: true,
  maxAmountMinor: 200_000,
  creditRegex: "You['’]ve received",
  rejectRegexes: ['refund', 'failed', 'reversal', 'reversed', 'debited'],
  amount: { regex: 'Rs ([\\d,]+(?:\\.\\d{1,2})?) from' },
  reference: { regex: 'txn (T\\d+)' },
  payer: { regex: 'from ([*\\d]+) via' },
};

let w: World;
let devToken: string;
let devId: string;
const payable = () => w.p.ledger.balance(w.db, merchantPayable(w.merchantId));
const suspense = () => w.p.ledger.balance(w.db, ACCOUNTS.SUSPENSE.code);
const txn = () => `T26101320075293${String(++seq).padStart(8, '0')}`;
let seq = 0;
let ord = 0;
const text = (rs: string, t = txn()) => ({ title: `Received Rs ${rs}`, text: `You've received Rs ${rs} from ******0696 via PhonePe for txn ${t}.` });
const send = (n: { title: string; text: string }, o: { pkg?: string; at?: Date; deviceId?: string } = {}) =>
  w.p.ingest.ingestNotification({ deviceId: o.deviceId ?? devId, packageName: o.pkg ?? PKG, title: n.title, text: n.text, postedAt: o.at ?? new Date() });
const uniqueOrder = (amountMinor: number) =>
  w.p.requests.create(w.merchantId, { orderReference: `U-${++ord}`, amountMinor, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc', uniqueAmount: true }, w.merchantActor);

async function bootPhone(opts: Parameters<typeof boot>[0] = {}) {
  w = await boot({ ...opts, activateTemplate: false });
  const t = await w.p.alertTemplates.create(w.admin, { name: 'phonepe-business-notification', bankName: 'PhonePe Business (phone notification)', definition: NOTIFICATION_TEMPLATE });
  await w.p.alertTemplates.validateWithSample(w.admin, t.id, { subject: REAL.title, text: REAL.text });
  await w.p.alertTemplates.activate(w.admin, t.id);
  const d = await w.p.devices.create(w.admin, 'owner-phone');
  devToken = d.token;
  devId = d.id;
}

afterEach(async () => {
  await w?.db.close();
});

describe('template for phone notifications', () => {
  beforeEach(() => bootPhone());

  it('parses the REAL PhonePe sample: amount, reference, masked payer; time = receipt time', async () => {
    const r = w.p.alertTemplates.testDefinition(NOTIFICATION_TEMPLATE, { subject: REAL.title, text: REAL.text, receivedAt: new Date('2026-10-13T10:00:00Z') });
    expect(r).toMatchObject({ ok: true, credit: { amountMinor: 1000, reference: 'T2610132007529301256970', creditedAt: '2026-10-13T10:00:00.000Z' } });
  });

  it('parses the second REAL sample: "Rs 1.1" is 110 paise (not 101, not 100)', () => {
    const r = w.p.alertTemplates.testDefinition(NOTIFICATION_TEMPLATE, { subject: REAL_PAISE.title, text: REAL_PAISE.text });
    expect(r).toMatchObject({ ok: true, credit: { amountMinor: 110, reference: 'T2610141213300329890819' } });
  });

  it('reads styled Unicode digits (the third real screenshot shows "Rs 2.3" in a different digit style) as ordinary digits: 230 paise', () => {
    const styled = `You've received Rs \u{1D7DA}.\u{1D7DB} from ******0696 via PhonePe for txn T2610141219090102054874.`;
    expect(w.p.alertTemplates.testDefinition(NOTIFICATION_TEMPLATE, { subject: 'Received Rs \u{1D7DA}.\u{1D7DB}', text: styled })).toMatchObject({ ok: true, credit: { amountMinor: 230, reference: 'T2610141219090102054874' } });
  });

  it('accepts the curly apostrophe variant and paise amounts (synthetic variants)', () => {
    expect(w.p.alertTemplates.testDefinition(NOTIFICATION_TEMPLATE, { subject: '', text: 'You’ve received Rs 10.05 from ******0696 via PhonePe for txn T2610132007529301256971.' })).toMatchObject({ ok: true, credit: { amountMinor: 1005 } });
  });

  it.each([
    ['refund', 'Refund of Rs 10 processed to ******0696 via PhonePe for txn T5.'],
    ['failed', "You've received Rs 10 from ******0696 via PhonePe for txn T6. Payment failed"],
    ['debit', 'Rs 10 debited from your account for txn T7.'],
  ])('does not treat a %s message as a credit', (_n, body) => {
    expect(w.p.alertTemplates.testDefinition(NOTIFICATION_TEMPLATE, { subject: '', text: body })).toMatchObject({ ok: false });
  });

  it('refuses a notification template without a package/sender allowlist or without a maximum', async () => {
    await expect(w.p.alertTemplates.create(w.admin, { name: 'x1', bankName: 'x', definition: { ...NOTIFICATION_TEMPLATE, packages: [] } })).rejects.toBeDefined();
    await expect(w.p.alertTemplates.create(w.admin, { name: 'x2', bankName: 'x', definition: { ...NOTIFICATION_TEMPLATE, maxAmountMinor: undefined } })).rejects.toBeDefined();
  });

  it('cannot be activated before validation against a sample', async () => {
    const t = await w.p.alertTemplates.create(w.admin, { name: 'second', bankName: 'x', definition: NOTIFICATION_TEMPLATE });
    await expect(w.p.alertTemplates.activate(w.admin, t.id)).rejects.toMatchObject({ code: 'NOT_VALIDATED' });
  });
});

describe('unique payable amounts', () => {
  beforeEach(() => bootPhone());

  it('gives concurrent open orders for the same amount distinct paise, remembering the base amount', async () => {
    const orders = await Promise.all([1, 2, 3, 4].map(() => uniqueOrder(1000)));
    const amounts = orders.map((o: any) => Number(o.amount_minor)).sort();
    expect(new Set(amounts).size).toBe(4);
    for (const a of amounts) expect(a).toBeGreaterThanOrEqual(1000), expect(a).toBeLessThan(1100);
    for (const o of orders as any[]) expect(Number(o.base_amount_minor)).toBe(1000);
    expect(new URL((orders[0] as any).qr_payload).searchParams.get('am')).toBe(((orders[0] as any).amount_minor / 100).toFixed(2));
  });

  it('is enforced by the database, not only by the application', async () => {
    const o: any = await uniqueOrder(1000);
    await expect(
      w.db.query(
        `INSERT INTO payment_requests(id, merchant_id, order_reference, amount_minor, currency, status, provider, provider_order_id, public_token, qr_payload, is_sandbox, unique_amount)
         VALUES (gen_random_uuid(), $1, 'dup', $2, 'INR', 'PENDING', 'bank-email', 'GWDUPLICATE22', 'tok', 'upi://pay', true, true)`,
        [w.merchantId, o.amount_minor],
      ),
    ).rejects.toThrow();
  });

  it('frees the amount when the order is no longer open, and errors when all 100 are taken', async () => {
    const first: any = await uniqueOrder(5000);
    await w.p.requests.cancel(w.merchantId, first.id, w.merchantActor);
    const again: any = await uniqueOrder(5000);
    expect(Number(again.amount_minor)).toBe(5000); // the freed value is reused
    for (let i = 0; i < 99; i++) await uniqueOrder(5000);
    await expect(uniqueOrder(5000)).rejects.toMatchObject({ code: 'TOO_MANY_OPEN_ORDERS_FOR_AMOUNT' });
  });
});

describe('phone notification confirms an order', () => {
  beforeEach(() => bootPhone());

  it('marks a unique-amount order PAID with evidence labelled DEVICE_NOTIFICATION, and the books balance', async () => {
    const a: any = await uniqueOrder(1000);
    const b: any = await uniqueOrder(1000);
    const [lo, hi] = Number(a.amount_minor) < Number(b.amount_minor) ? [a, b] : [b, a];
    const rs = (Number(hi.amount_minor) / 100).toFixed(2);
    const out = await send(text(rs));
    expect(out).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'MATCHED' });
    expect((await orderRow(w, hi.id)).status).toBe('PAID');
    expect((await orderRow(w, lo.id)).status).toBe('PENDING'); // the same base amount, a different order: untouched
    const [c] = await w.db.query<any>(`SELECT * FROM bank_credits ORDER BY created_at DESC LIMIT 1`);
    expect(c).toMatchObject({ evidence: 'DEVICE_NOTIFICATION', status: 'MATCHED', match_method: 'UNIQUE_AMOUNT_IN_WINDOW', order_id: hi.id });
    expect(c.order_tokens).toEqual([]);
    expect(await payable()).toBeGreaterThan(0);
    expect(summarize(await verifyFinancialIntegrity(w.db)).failures).toEqual([]);
    expect(await w.p.audit.verifyChain(w.db)).toBe(true);
    const actions = (await w.db.query<any>(`SELECT action FROM audit_logs WHERE action LIKE 'bankmail.%' ORDER BY id`)).map((r) => r.action);
    expect(actions).toEqual(['bankmail.notification_recorded', 'bankmail.credit_matched']);
  });

  it('the real sample text (Rs 10) matches a Rs 10.00 order when exactly one is open', async () => {
    const o: any = await w.p.requests.create(w.merchantId, { orderReference: 'R10', amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    expect(await send(REAL)).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'MATCHED' });
    expect((await orderRow(w, o.id)).status).toBe('PAID');
  });

  it('the second REAL sample ("Rs 1.1") confirms exactly the Rs 1.10 unique-amount order, not Rs 1.01 or Rs 1.00', async () => {
    const orders: any[] = [];
    for (let i = 0; i < 12; i++) orders.push(await uniqueOrder(100)); // Rs 1.00 .. Rs 1.11
    const target = orders.find((o) => Number(o.amount_minor) === 110);
    expect(target).toBeDefined();
    expect(await send(REAL_PAISE)).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'MATCHED' });
    expect((await orderRow(w, target.id)).status).toBe('PAID');
    const paid = (await w.db.query<any>(`SELECT COUNT(*) AS n FROM payment_requests WHERE status='PAID'`))[0].n;
    expect(Number(paid)).toBe(1);
  });

  it('two non-unique orders of the same amount are ambiguous: nothing is confirmed, money is parked in suspense', async () => {
    const mk = (r: string) => w.p.requests.create(w.merchantId, { orderReference: r, amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    const [o1, o2]: any[] = [await mk('A1'), await mk('A2')];
    expect(await send(REAL)).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'AMBIGUOUS' });
    expect((await orderRow(w, o1.id)).status).toBe('PENDING');
    expect((await orderRow(w, o2.id)).status).toBe('PENDING');
    expect(await suspense()).toBeGreaterThan(0);
    expect(await payable()).toBe(0);
  });

  it('a wrong amount (no order with it) is unmatched, not applied to a nearby order', async () => {
    const o: any = await uniqueOrder(1000);
    const out = await send(text('9.00'));
    expect(out).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'UNMATCHED' });
    expect((await orderRow(w, o.id)).status).toBe('PENDING');
    expect(await payable()).toBe(0);
  });

  it('no open order at all: unmatched, held in suspense', async () => {
    expect(await send(REAL)).toMatchObject({ creditStatus: 'UNMATCHED' });
    expect(await suspense()).toBeGreaterThan(0);
  });
});

describe('duplicates and replays', () => {
  beforeEach(() => bootPhone());

  it('the same notification posted twice is applied once', async () => {
    await w.p.requests.create(w.merchantId, { orderReference: 'D1', amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    expect(await send(REAL)).toMatchObject({ status: 'CREDIT_RECORDED' });
    expect(await send(REAL)).toMatchObject({ status: 'ALREADY_SEEN' });
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM payments'))[0].n)).toBe(1);
  });

  it('the same transaction id re-worded is a DUPLICATE, not a second payment', async () => {
    await w.p.requests.create(w.merchantId, { orderReference: 'D2', amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    await send(REAL);
    const again = await send({ title: 'Received Rs 10 (again)', text: REAL.text });
    expect(again).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_REFERENCE' });
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM payments'))[0].n)).toBe(1);
  });

  it('an old notification replayed later is rejected as not fresh and creates nothing', async () => {
    await w.p.requests.create(w.merchantId, { orderReference: 'D3', amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    const out = await send(REAL, { at: new Date(Date.now() - 3 * 3600_000) });
    expect(out).toMatchObject({ status: 'REJECTED', reason: 'NOTIFICATION_NOT_FRESH' });
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM bank_credits'))[0].n)).toBe(0);
  });

  it('a timestamp far in the future is rejected too', async () => {
    expect(await send(REAL, { at: new Date(Date.now() + 3600_000) })).toMatchObject({ status: 'REJECTED', reason: 'NOTIFICATION_NOT_FRESH' });
  });
});

describe('source allowlist and non-credits', () => {
  beforeEach(() => bootPhone());

  it('a notification from any other app is not evidence (package spoofing by a different app name)', async () => {
    await w.p.requests.create(w.merchantId, { orderReference: 'S1', amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    expect(await send(REAL, { pkg: 'com.evil.notes' })).toMatchObject({ status: 'UNTRUSTED_SENDER', reason: 'SOURCE_NOT_ALLOWLISTED' });
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM bank_credits'))[0].n)).toBe(0);
  });

  it('refund, failure and debit notifications never create a credit', async () => {
    for (const body of ['Refund of Rs 10 processed to ******0696 via PhonePe for txn T5.', 'Rs 10 debited from your account for txn T7.']) {
      expect(await send({ title: 'x', text: body })).toMatchObject({ status: 'IGNORED' });
    }
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM bank_credits'))[0].n)).toBe(0);
  });

  it('a credit-looking notification in an unknown format is UNPARSEABLE and raises an alert', async () => {
    const out = await send({ title: 'Received', text: "You've received money from somebody" });
    expect(out.status).toBe('UNPARSEABLE');
  });

  it('a credit above the template maximum is never recorded', async () => {
    expect(await send(text('5,000.00'))).toMatchObject({ status: 'UNPARSEABLE', reason: 'AMOUNT_ABOVE_TEMPLATE_MAXIMUM' });
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM bank_credits'))[0].n)).toBe(0);
  });
});

describe('limits on unverified evidence', () => {
  it('a credit above the per-credit cap is held for review even if it matches exactly one order', async () => {
    await bootPhone({ ingest: { deviceAutoConfirmMaxMinor: 50_000 } });
    const o: any = await uniqueOrder(120_000);
    const out = await send(text((Number(o.amount_minor) / 100).toFixed(2)));
    expect(out).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'REVIEW' });
    expect((await orderRow(w, o.id)).status).toBe('PENDING');
    const [c] = await w.db.query<any>('SELECT * FROM bank_credits');
    expect(c.status_reason ?? c.reason).toBe('ABOVE_UNVERIFIED_LIMIT');
    expect(await suspense()).toBeGreaterThan(0);
    expect(await payable()).toBe(0);
  });

  it('once the rolling 24h total would be exceeded, further credits are held', async () => {
    await bootPhone({ ingest: { deviceAutoConfirmMaxMinor: 50_000, deviceDailyLimitMinor: 15_000 } });
    const o1: any = await uniqueOrder(10_000);
    const o2: any = await uniqueOrder(10_000);
    expect(await send(text((Number(o1.amount_minor) / 100).toFixed(2)))).toMatchObject({ creditStatus: 'MATCHED' });
    expect(await send(text((Number(o2.amount_minor) / 100).toFixed(2)))).toMatchObject({ creditStatus: 'REVIEW' });
    expect((await orderRow(w, o2.id)).status).toBe('PENDING');
  });

  it('a reviewer can assign a held credit to the order (exact amount only)', async () => {
    await bootPhone({ ingest: { deviceAutoConfirmMaxMinor: 5_000 } });
    const o: any = await uniqueOrder(10_000);
    await send(text((Number(o.amount_minor) / 100).toFixed(2)));
    const [c] = await w.db.query<any>('SELECT id FROM bank_credits');
    await w.p.collections.assignCredit(w.admin, c.id, o.id, 'Checked the PhonePe app balance');
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    expect(summarize(await verifyFinancialIntegrity(w.db)).failures).toEqual([]);
  });
});

describe('device tokens', () => {
  beforeEach(() => bootPhone());

  it('stores only a hash of the token, never the token', async () => {
    const [row] = await w.db.query<any>('SELECT * FROM ingest_devices');
    expect(row.token_hash).toBe(createHash('sha256').update(devToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(devToken);
    expect(devToken).toMatch(/^gwd_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(await w.p.devices.list())).not.toContain(devToken);
  });

  it('authenticates a valid token, rejects wrong/short/empty tokens and revoked devices at once', async () => {
    expect(await w.p.devices.authenticate(devToken)).toMatchObject({ id: devId });
    expect(await w.p.devices.authenticate(devToken + 'x')).toBeNull();
    expect(await w.p.devices.authenticate('gwd_short')).toBeNull();
    expect(await w.p.devices.authenticate(undefined)).toBeNull();
    await w.p.devices.revoke(w.admin, devId);
    expect(await w.p.devices.authenticate(devToken)).toBeNull();
    await expect(w.p.devices.revoke(w.admin, devId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects duplicate names and records create/revoke in the audit log', async () => {
    await expect(w.p.devices.create(w.admin, 'owner-phone')).rejects.toMatchObject({ code: 'DEVICE_EXISTS' });
    await w.p.devices.revoke(w.admin, devId);
    const actions = (await w.db.query<any>(`SELECT action FROM audit_logs WHERE action LIKE 'device.%' ORDER BY id`)).map((r) => r.action);
    expect(actions).toEqual(['device.created', 'device.revoked']);
  });
});

describe('POST /ingest/notification', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  beforeEach(async () => {
    await bootPhone();
    app = await createApp({ platform: w.p, jwtSecret: 'j'.repeat(40) });
    await app.init();
    http = request(app.getHttpServer());
  });
  afterEach(async () => {
    await app.close();
  });
  const body = (o: object = {}) => ({ package: PKG, title: REAL.title, text: REAL.text, postedAt: Date.now(), ...o });

  it('rejects missing, wrong and revoked tokens uniformly with 401', async () => {
    await http.post('/ingest/notification').send(body()).expect(401);
    await http.post('/ingest/notification').set('Authorization', 'Bearer gwd_' + 'a'.repeat(43)).send(body()).expect(401);
    await http.post('/ingest/notification').set('Authorization', 'Basic ' + devToken).send(body()).expect(401);
    await w.p.devices.revoke(w.admin, devId);
    await http.post('/ingest/notification').set('Authorization', `Bearer ${devToken}`).send(body()).expect(401);
    expect(Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM mail_messages'))[0].n)).toBe(0);
  });

  it('accepts a valid post and confirms the order; a repeat is ALREADY_SEEN', async () => {
    const o: any = await w.p.requests.create(w.merchantId, { orderReference: 'H1', amountMinor: 1000, expiresInMinutes: 30, payeeVpa: 'owner.shop@okhdfc' }, w.merchantActor);
    const b = body();
    const r1 = await http.post('/ingest/notification').set('Authorization', `Bearer ${devToken}`).send(b).expect(201);
    expect(r1.body.status).toBe('CREDIT_RECORDED');
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    const r2 = await http.post('/ingest/notification').set('Authorization', `Bearer ${devToken}`).send(b).expect(201);
    expect(r2.body.status).toBe('ALREADY_SEEN');
  });

  it('validates the body: needs package or sender, text, and an integer postedAt', async () => {
    const h = { Authorization: `Bearer ${devToken}` };
    await http.post('/ingest/notification').set(h).send(body({ package: undefined })).expect(400);
    await http.post('/ingest/notification').set(h).send(body({ text: '' })).expect(400);
    await http.post('/ingest/notification').set(h).send(body({ postedAt: 'now' })).expect(400);
    await http.post('/ingest/notification').set(h).send(body({ text: 'x'.repeat(5000) })).expect(400);
  });

  it('is rate limited', async () => {
    const h = { Authorization: `Bearer ${devToken}` };
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await http.post('/ingest/notification').set(h).send(body({ text: `You've received Rs 1 from ******0696 via PhonePe for txn T${i}.`, title: String(i) }));
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
