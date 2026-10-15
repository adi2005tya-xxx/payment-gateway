import { ACCOUNTS, merchantPayable } from '../src/ledger/ledger.service';
import { summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { attackerKey, BANK_FROM, boot, creditRow, ingest, makeAlert, newOrder, nextRef, orderRow, signCustom, World, TEMPLATE_DEFINITION } from './bank-email-helpers';

// ALL BANK EMAILS IN THESE TESTS ARE SYNTHETIC (see bank-email-helpers.ts). They are not any real bank's format.
jest.setTimeout(180_000);

let w: World;
const min = 60_000;
const CRLF = String.fromCharCode(13, 10);
const payable = () => w.p.ledger.balance(w.db, merchantPayable(w.merchantId));
const suspense = () => w.p.ledger.balance(w.db, ACCOUNTS.SUSPENSE.code);
const creditsCount = async () => Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM bank_credits'))[0].n);
const paymentsCount = async () => Number((await w.db.query<any>('SELECT COUNT(*) AS n FROM payments'))[0].n);

afterEach(async () => {
  await w?.db.close();
});

describe('a genuine bank credit alert confirms an order', () => {
  beforeEach(async () => {
    w = await boot();
  });

  it('creates a unique order id inside a UPI link for the entered payee, then marks it PAID only from the verified alert', async () => {
    const o1 = await newOrder(w, 125_000, { payee: 'Owner.Shop@OkHDFC' });
    const o2 = await newOrder(w, 125_000);
    const u = new URL(o1.qr_payload);
    expect(u.protocol).toBe('upi:');
    expect(u.searchParams.get('pa')).toBe('owner.shop@okhdfc'); // normalised payee
    expect(u.searchParams.get('am')).toBe('1250.00');
    expect(u.searchParams.get('cu')).toBe('INR');
    expect(u.searchParams.get('tr')).toBe(o1.provider_order_id);
    expect(o1.provider_order_id).toMatch(/^GW[A-Z2-9]{10}$/);
    expect(o1.provider_order_id).not.toBe(o2.provider_order_id);
    expect(o1.status).toBe('PENDING');
    expect(o1.payee_vpa).toBe('owner.shop@okhdfc');
    expect((await w.p.requests.publicView(o1.public_token)).status).toBe('AWAITING_PAYMENT'); // a QR is not proof of anything

    const ref = nextRef();
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, reference: ref, orderId: o1.provider_order_id }));
    expect(out).toMatchObject({ status: 'CREDIT_RECORDED', creditStatus: 'MATCHED' });
    expect((await orderRow(w, o1.id)).status).toBe('PAID');
    expect((await orderRow(w, o2.id)).status).toBe('PENDING'); // the other order with the same amount is untouched
    const c = await creditRow(w, ref);
    expect(c).toMatchObject({ status: 'MATCHED', match_method: 'ORDER_REFERENCE', evidence: 'BANK_EMAIL', order_id: o1.id, payer_masked: 'pa****@okhdfc' });
    const [pay] = await w.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [ref]);
    expect(pay).toMatchObject({ status: 'SUCCEEDED', provider: 'bank-email', amount_minor: 125_000, fee_minor: 2500, verification_result: 'VERIFIED' });
    expect(await payable()).toBe(122_500);
    expect((await w.p.requests.publicView(o1.public_token)).status).toBe('PAID');

    const dash = await w.p.collections.dashboard();
    expect(dash).toMatchObject({ paid: { count: 1, amountMinor: 125_000 }, pending: { count: 1 }, unmatched: { count: 0 } });
    expect(summarize(await verifyFinancialIntegrity(w.db)).failures).toEqual([]);
    expect((await w.p.reconciliation.run()).items).toEqual([]);
    const actions = (await w.db.query<any>(`SELECT action FROM audit_logs WHERE action LIKE 'bankmail.%' ORDER BY id`)).map((r) => r.action);
    expect(actions).toEqual(['bankmail.credit_recorded', 'bankmail.credit_matched']);
    expect(await w.p.audit.verifyChain(w.db)).toBe(true);
  });

  it('refuses a payee that is not a UPI ID, and requires one in this mode', async () => {
    await expect(w.p.requests.create(w.merchantId, { orderReference: 'X1', amountMinor: 10_000, payeeVpa: 'not-a-upi' }, w.merchantActor)).rejects.toMatchObject({ code: 'INVALID_VPA' });
    await expect(w.p.requests.create(w.merchantId, { orderReference: 'X2', amountMinor: 10_000 }, w.merchantActor)).rejects.toMatchObject({ code: 'PAYEE_REQUIRED' });
  });

  it('payouts and refunds are disabled in this mode: no settlement can be started from bank-email evidence', async () => {
    const o = await newOrder(w);
    await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
    await expect(w.provider.createPayout()).rejects.toMatchObject({ code: 'PAYOUTS_DISABLED' });
    await expect(w.provider.createRefund()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(w.provider.isSandbox).toBe(true);
  });
});

describe('forged and unauthenticated emails are never payment evidence', () => {
  beforeEach(async () => {
    w = await boot();
  });

  const forged: Array<[string, (orderId: string) => Promise<Buffer>, string, string]> = [
    ['unsigned email from the bank address', (o) => makeAlert({ amountMinor: 125_000, orderId: o, sign: false }), 'AUTH_FAILED', 'DKIM_NOT_PASSING'],
    ['bank address, VALIDLY signed by the attacker\'s own domain', (o) => makeAlert({ amountMinor: 125_000, orderId: o, sign: { domain: 'evil.example', key: attackerKey } }), 'AUTH_FAILED', 'DKIM_DOMAIN_NOT_ALLOWED_OR_NOT_ALIGNED'],
    ['bank address signed with the attacker\'s key but claiming the bank domain', (o) => makeAlert({ amountMinor: 125_000, orderId: o, sign: { domain: 'testbank.example', key: attackerKey } }), 'AUTH_FAILED', 'DKIM_NOT_PASSING'],
    ['genuine signature, body altered afterwards', async (o) => Buffer.from((await makeAlert({ amountMinor: 1_000, orderId: o })).toString().replace('Rs. 10.00', 'Rs. 1,250.00')), 'AUTH_FAILED', 'DKIM_NOT_PASSING'],
    ['a forged Authentication-Results header claiming dkim=pass', (o) => makeAlert({ amountMinor: 125_000, orderId: o, sign: false, extraHeaders: ['Authentication-Results: mx.google.com; dkim=pass header.d=testbank.example; spf=pass; dmarc=pass'] }), 'AUTH_FAILED', 'DKIM_NOT_PASSING'],
    ['signature whose key is not published in DNS', (o) => makeAlert({ amountMinor: 125_000, orderId: o, sign: { domain: 'testbank.example', selector: 's2' } }), 'AUTH_FAILED', 'DKIM_NOT_PASSING'],
    ['a valid bank signature that does not cover the From header', async (o) => signCustom(await makeAlert({ amountMinor: 125_000, orderId: o, sign: false }), { domain: 'testbank.example', signedHeaders: ['subject', 'date', 'message-id'] }), 'AUTH_FAILED', 'DKIM_DOES_NOT_SIGN_FROM'],
    ['attacker domain with a display name pretending to be the bank', (o) => makeAlert({ amountMinor: 125_000, orderId: o, fromHeader: '"alerts@testbank.example" <pay@evil.example>', sign: { domain: 'evil.example', key: attackerKey } }), 'UNTRUSTED_SENDER', 'SENDER_NOT_ALLOWLISTED'],
    ['lookalike sender domain', (o) => makeAlert({ amountMinor: 125_000, orderId: o, fromHeader: 'alerts@testbank-example.test', sign: false }), 'UNTRUSTED_SENDER', 'SENDER_NOT_ALLOWLISTED'],
    ['bank domain as a subdomain of the attacker', (o) => makeAlert({ amountMinor: 125_000, orderId: o, fromHeader: 'alerts@testbank.example.evil.test', sign: false }), 'UNTRUSTED_SENDER', 'SENDER_NOT_ALLOWLISTED'],
    ['two From addresses', (o) => makeAlert({ amountMinor: 125_000, orderId: o, fromHeader: `${BANK_FROM}, pay@evil.example`, sign: false }), 'UNTRUSTED_SENDER', 'FROM_HEADER_INVALID'],
    ['an email forwarded by a customer (their address is the sender)', (o) => makeAlert({ amountMinor: 125_000, orderId: o, fromHeader: 'customer@gmail.example', sign: { domain: 'gmail.example' } }), 'UNTRUSTED_SENDER', 'SENDER_NOT_ALLOWLISTED'],
  ];
  it.each(forged)('%s', async (_name, build, status, reasonStart) => {
    const o = await newOrder(w);
    const out = await ingest(w, await build(o.provider_order_id));
    expect(out.status).toBe(status);
    expect(out.reason ?? '').toContain(reasonStart);
    expect(await creditsCount()).toBe(0);
    expect(await paymentsCount()).toBe(0);
    expect((await orderRow(w, o.id)).status).toBe('PENDING'); // nothing was credited
    expect(await payable()).toBe(0);
  });

  it('a signature with a body-length limit is rejected (content could be appended after the signed part)', async () => {
    const o = await newOrder(w);
    const ref = nextRef();
    const plain = await makeAlert({ amountMinor: 1_000, reference: ref, orderId: o.provider_order_id, sign: false });
    const bodyLen = plain.toString().split(CRLF + CRLF)[1].length;
    // Sign only the first bodyLen bytes (DKIM l= tag), then APPEND a second, forged credit sentence after the signed part.
    const limited = await makeAlert({ amountMinor: 1_000, reference: ref, orderId: o.provider_order_id, sign: { domain: 'testbank.example', maxBodyLength: bodyLen } });
    expect(limited.toString()).toMatch(/l=\d+/); // the signature really carries a length limit
    const tampered = Buffer.from(limited.toString() + 'Also Rs. 1,250.00 credited to your a/c XX1234 on 13-10-2026 11:02:33. Ref No 999999999999.' + CRLF); // new line after the signed part
    const out = await ingest(w, tampered);
    expect(out.status).toBe('AUTH_FAILED');
    expect(out.reason).toBe('DKIM_BODY_LENGTH_LIMIT_NOT_ACCEPTED');
    expect(await creditsCount()).toBe(0);
  });

  it('raises an alert for forgeries of an allowlisted sender, writes an audit entry, and a genuine email still works afterwards', async () => {
    const o = await newOrder(w);
    await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, sign: false }));
    expect((await w.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['BANK_EMAIL_AUTH_FAILURE'])).length).toBe(1);
    expect((await w.db.query('SELECT 1 FROM audit_logs WHERE action=$1', ['bankmail.auth_failed'])).length).toBe(1);
    const ok = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
    expect(ok.creditStatus).toBe('MATCHED');
    expect((await orderRow(w, o.id)).status).toBe('PAID');
  });

  it('with no active template nothing is trusted, even a perfectly signed email', async () => {
    await w.db.close();
    w = await boot({ activateTemplate: false });
    const o = await newOrder(w);
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
    expect(out).toMatchObject({ status: 'UNTRUSTED_SENDER', reason: 'SENDER_NOT_ALLOWLISTED' });
    expect(await creditsCount()).toBe(0);
  });

  it('a template that was disabled stops confirming payments', async () => {
    const o = await newOrder(w);
    await w.p.alertTemplates.disable(w.admin, w.templateId);
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
    expect(out.status).toBe('UNTRUSTED_SENDER');
    expect((await orderRow(w, o.id)).status).toBe('PENDING');
  });
});

describe('duplicate alerts', () => {
  beforeEach(async () => {
    w = await boot();
  });

  it('the same email delivered twice, or re-delivered under a new id, or re-sent by the bank with the same reference, credits once', async () => {
    const o = await newOrder(w);
    const ref = nextRef();
    const raw = await makeAlert({ amountMinor: 125_000, reference: ref, orderId: o.provider_order_id });
    expect((await ingest(w, raw, 'gm-1')).creditStatus).toBe('MATCHED');
    expect((await ingest(w, raw, 'gm-1')).status).toBe('ALREADY_SEEN'); // same message id
    expect(await ingest(w, raw, 'gm-2')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_CONTENT' }); // same bytes, new id
    const resent = await makeAlert({ amountMinor: 125_000, reference: ref, orderId: o.provider_order_id, extraBody: 'Thank you for banking with us.' }); // bank re-sends, different text
    expect(await ingest(w, resent, 'gm-3')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_REFERENCE' });
    expect(await creditsCount()).toBe(1);
    expect(await paymentsCount()).toBe(1);
    expect(await payable()).toBe(122_500);
    expect((await w.db.query('SELECT 1 FROM ledger_journals WHERE kind=$1', ['COLLECTION'])).length).toBe(1);
  });

  it('concurrent deliveries of one alert produce one credit, one payment and exactly one notification', async () => {
    const o = await newOrder(w);
    const raw = await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ingest(w, raw, `race-${i}`)));
    expect(results.filter((r) => r.creditStatus === 'MATCHED')).toHaveLength(1);
    expect(await creditsCount()).toBe(1);
    expect(await paymentsCount()).toBe(1);
    expect(await payable()).toBe(122_500);
    await w.p.notifications.dispatchDue();
    await w.p.notifications.dispatchDue(new Date(Date.now() + 3600_000));
    expect(w.notifier.sent.filter((m) => m.subject === 'Payment received')).toHaveLength(1);
  });

  it('a second, different payment for an order that is already PAID is held, not credited', async () => {
    const o = await newOrder(w);
    await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
    const second = await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id });
    const out = await ingest(w, second);
    expect(out.creditStatus).toBe('REVIEW');
    expect(await payable()).toBe(122_500);
    expect(await suspense()).toBe(125_000);
    expect((await w.db.query<any>(`SELECT verification_result FROM payments WHERE status='UNDER_REVIEW'`))[0].verification_result).toContain('DUPLICATE_PAYMENT_FOR_ORDER');
  });
});

describe('wrong amounts', () => {
  beforeEach(async () => {
    w = await boot();
  });

  it.each([
    ['underpayment', 120_000],
    ['overpayment', 130_000],
    ['off by one paisa', 125_001],
    ['a tenth of the amount (decimal slip)', 12_500],
  ])('%s is held for review and the order is NOT paid', async (_n, amount) => {
    const o = await newOrder(w, 125_000);
    const ref = nextRef();
    const out = await ingest(w, await makeAlert({ amountMinor: amount, reference: ref, orderId: o.provider_order_id }));
    expect(out.creditStatus).toBe('REVIEW');
    const c = await creditRow(w, ref);
    expect(c.reason).toContain('AMOUNT_MISMATCH');
    expect((await orderRow(w, o.id)).status).toBe('UNDER_REVIEW');
    expect(await payable()).toBe(0);
    expect(await suspense()).toBe(amount); // the money is real, so it is booked, but to suspense, never to the merchant
    expect((await w.db.query<any>(`SELECT status FROM payments WHERE provider_payment_id=$1`, [ref]))[0].status).toBe('UNDER_REVIEW');
    expect((await w.db.query('SELECT 1 FROM risk_reviews WHERE status=$1', ['OPEN'])).length).toBe(1);
    expect((await w.p.collections.dashboard()).underReview.count).toBe(1);
  });

  it('a reviewer cannot make a different amount count as payment', async () => {
    const o = await newOrder(w, 125_000);
    const ref = nextRef();
    await ingest(w, await makeAlert({ amountMinor: 120_000, reference: ref, orderId: o.provider_order_id }));
    const c = await creditRow(w, ref);
    await expect(w.p.collections.assignCredit(w.admin, c.id, o.id, 'customer said they would pay the rest later')).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect((await orderRow(w, o.id)).status).toBe('UNDER_REVIEW');
    expect(await payable()).toBe(0);
  });

  it('keeps paise exactly (no floating point): 1,250.50 matches 125050 and nothing else', async () => {
    const o = await newOrder(w, 125_050);
    expect((await ingest(w, await makeAlert({ amountMinor: 125_050, orderId: o.provider_order_id }))).creditStatus).toBe('MATCHED');
  });
});

describe('delayed, missing and badly timed alerts', () => {
  beforeEach(async () => {
    w = await boot();
  });

  it('an alert that arrives 25 minutes after the credit still confirms an order whose window contained the credit', async () => {
    const o = await newOrder(w, 125_000, { minutes: 30 });
    const creditTime = new Date(Date.now() + 1 * min);
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: creditTime }), 'late-1', new Date(creditTime.getTime() + 25 * min));
    expect(out.creditStatus).toBe('MATCHED');
    expect((await orderRow(w, o.id)).status).toBe('PAID');
  });

  it('an order stays PENDING through the grace period after expiry, so a delayed alert can still confirm it', async () => {
    const o = await newOrder(w, 125_000, { minutes: 30 });
    await w.db.query(`UPDATE payment_requests SET created_at = now() - interval '50 minutes', expires_at = now() - interval '10 minutes' WHERE id=$1`, [o.id]);
    expect(await w.p.requests.expireStale()).toBe(0); // still inside the 60-minute grace
    const creditTime = new Date(Date.now() - 20 * min); // paid while the order was valid
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: creditTime }), 'late-2', new Date());
    expect(out.creditStatus).toBe('MATCHED');
    expect((await orderRow(w, o.id)).status).toBe('PAID');
  });

  it('after the grace period the order EXPIRES; a very late genuine alert is held for review and a reviewer can then assign it', async () => {
    const o = await newOrder(w, 125_000, { minutes: 30 });
    await w.db.query(`UPDATE payment_requests SET created_at = now() - interval '4 hours', expires_at = now() - interval '3 hours 30 minutes' WHERE id=$1`, [o.id]);
    expect(await w.p.requests.expireStale()).toBe(1);
    expect((await orderRow(w, o.id)).status).toBe('EXPIRED');
    const ref = nextRef();
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, reference: ref, orderId: o.provider_order_id, at: new Date(Date.now() - 3.7 * 3600_000) }), 'late-3', new Date());
    expect(out.creditStatus).toBe('REVIEW');
    expect((await creditRow(w, ref)).reason).toContain('REQUEST_EXPIRED');
    expect((await orderRow(w, o.id)).status).toBe('EXPIRED'); // still not paid
    expect(await payable()).toBe(0);

    const c = await creditRow(w, ref);
    await expect(w.p.collections.assignCredit(w.admin, c.id, o.id, 'short')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    await w.p.collections.assignCredit(w.admin, c.id, o.id, 'Checked the bank statement: this credit is for this order');
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    expect((await creditRow(w, ref))).toMatchObject({ status: 'MATCHED', match_method: 'MANUAL_ASSIGN' });
    expect(await payable()).toBe(122_500);
    expect(await suspense()).toBe(0);
    expect(summarize(await verifyFinancialIntegrity(w.db)).failures).toEqual([]);
  });

  it('a credit made before the order existed (outside its window) is held, never matched', async () => {
    const o = await newOrder(w, 125_000);
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: new Date(Date.now() - 30 * min) }), 'early', new Date());
    expect(out.creditStatus).toBe('REVIEW');
    expect((await orderRow(w, o.id)).status).toBe('PENDING');
    expect(await payable()).toBe(0);
    expect(await suspense()).toBe(125_000);
  });

  it('an alert whose credit time is later than the moment it was received is rejected as impossible', async () => {
    const o = await newOrder(w);
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: new Date(Date.now() + 30 * min) }), 'future', new Date());
    expect(out).toMatchObject({ status: 'REJECTED', reason: 'CREDIT_TIME_AFTER_EMAIL_RECEIPT' });
    expect(await creditsCount()).toBe(0);
    expect((await w.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['BANK_EMAIL_SUSPICIOUS'])).length).toBe(1);
  });

  it('an old alert (replay of a stale email) is rejected as evidence', async () => {
    const o = await newOrder(w);
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, at: new Date(Date.now() - 72 * 3600_000) }), 'old', new Date());
    expect(out).toMatchObject({ status: 'REJECTED', reason: 'CREDIT_TOO_OLD' });
    expect(await creditsCount()).toBe(0);
  });

  it('a MISSING alert never marks an order paid: it expires; only a dual-controlled, labelled attestation can resolve it', async () => {
    const o = await newOrder(w, 125_000, { minutes: 30 });
    await w.db.query(`UPDATE payment_requests SET created_at = now() - interval '5 hours', expires_at = now() - interval '4 hours 30 minutes' WHERE id=$1`, [o.id]);
    await w.p.requests.expireStale();
    expect((await orderRow(w, o.id)).status).toBe('EXPIRED');
    expect(await payable()).toBe(0);

    const when = new Date(Date.now() - 4.8 * 3600_000);
    const ref = '412345678901';
    await expect(w.p.collections.proposeAttestation(w.admin, o.id, ref, when, 'short')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    await expect(w.p.collections.proposeAttestation(w.admin, o.id, 'x', when, 'statement line 42 on the bank portal')).rejects.toMatchObject({ code: 'BAD_REFERENCE' });
    await expect(w.p.collections.proposeAttestation(w.admin, o.id, ref, new Date(Date.now() + 3600_000), 'statement line 42 on the bank portal')).rejects.toMatchObject({ code: 'BAD_TIME' });
    const prop = await w.p.collections.proposeAttestation(w.admin, o.id, ref, when, 'Statement line 42 in the bank portal shows this credit');
    expect((await orderRow(w, o.id)).status).toBe('EXPIRED'); // proposing changes nothing
    await expect(w.p.collections.decideAttestation(w.admin, prop.id, 'APPLY')).rejects.toMatchObject({ code: 'DUAL_APPROVAL_REQUIRED' });
    expect(await w.p.collections.decideAttestation(w.admin2, prop.id, 'APPLY')).toMatchObject({ applied: true });
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    expect(await creditRow(w, ref)).toMatchObject({ evidence: 'MANUAL_ATTESTATION', status: 'MATCHED' });
    expect((await w.db.query<any>(`SELECT verification_result FROM payments WHERE provider_payment_id=$1`, [ref]))[0].verification_result).toBe('MANUAL_ATTESTED');
    expect(await payable()).toBe(122_500);
    expect(summarize(await verifyFinancialIntegrity(w.db)).failures).toEqual([]);
    // The bank's real alert for the same reference arriving later cannot double-credit.
    const late = await ingest(w, await makeAlert({ amountMinor: 125_000, reference: ref, orderId: o.provider_order_id, at: when }), 'real-late', new Date());
    expect(late.status).toBe('DUPLICATE');
    expect(await payable()).toBe(122_500);
  });

  it('an attestation can be rejected by the second administrator and does nothing', async () => {
    const o = await newOrder(w);
    const prop = await w.p.collections.proposeAttestation(w.admin, o.id, '512345678901', new Date(), 'Customer says they paid; bank portal line 7');
    await w.p.collections.decideAttestation(w.admin2, prop.id, 'REJECT');
    expect((await orderRow(w, o.id)).status).toBe('PENDING');
    expect(await creditsCount()).toBe(0);
  });
});

describe('ambiguous or unreferenced credits are held, not guessed', () => {
  beforeEach(async () => {
    w = await boot();
  });

  it('default policy: a credit with the right amount but no order id stays UNMATCHED, order stays PENDING, money sits in suspense', async () => {
    const o = await newOrder(w, 125_000);
    const ref = nextRef();
    const out = await ingest(w, await makeAlert({ amountMinor: 125_000, reference: ref }));
    expect(out.creditStatus).toBe('UNMATCHED');
    expect((await creditRow(w, ref)).reason).toBe('NO_ORDER_REFERENCE_IN_ALERT');
    expect((await orderRow(w, o.id)).status).toBe('PENDING');
    expect(await payable()).toBe(0);
    expect(await suspense()).toBe(125_000);
    expect((await w.p.collections.dashboard()).unmatched).toEqual({ count: 1, amountMinor: 125_000 });
    expect((await w.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['BANK_CREDIT_NEEDS_REVIEW'])).length).toBe(1);
  });

  it('an unknown order id and an alert naming two orders are both held', async () => {
    const a = await newOrder(w, 125_000);
    const b = await newOrder(w, 125_000);
    const unknown = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: 'GWZZZZZZZZZZ' }));
    expect(unknown.creditStatus).toBe('UNMATCHED');
    const both = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: [a.provider_order_id, b.provider_order_id] }));
    expect(both.creditStatus).toBe('AMBIGUOUS');
    expect((await orderRow(w, a.id)).status).toBe('PENDING');
    expect((await orderRow(w, b.id)).status).toBe('PENDING');
  });

  it('a reviewer can resolve an ambiguous credit to one order (exact amount), or dismiss it', async () => {
    const a = await newOrder(w, 125_000);
    const b = await newOrder(w, 125_000);
    const ref = nextRef();
    await ingest(w, await makeAlert({ amountMinor: 125_000, reference: ref, orderId: [a.provider_order_id, b.provider_order_id] }));
    const c = await creditRow(w, ref);
    expect(c.candidates.sort()).toEqual([a.id, b.id].sort());
    await w.p.collections.assignCredit(w.admin, c.id, b.id, 'The customer of order B showed the UTR matching this credit');
    expect((await orderRow(w, b.id)).status).toBe('PAID');
    expect((await orderRow(w, a.id)).status).toBe('PENDING');
    await expect(w.p.collections.assignCredit(w.admin, c.id, a.id, 'assigning the same credit twice must fail')).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' });

    const ref2 = nextRef();
    await ingest(w, await makeAlert({ amountMinor: 99_900, reference: ref2 }));
    const c2 = await creditRow(w, ref2);
    await expect(w.p.collections.dismissCredit(w.admin, c2.id, 'short')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    await w.p.collections.dismissCredit(w.admin, c2.id, 'Unrelated transfer from a friend, not an order');
    expect((await creditRow(w, ref2)).status).toBe('DISMISSED');
    expect(summarize(await verifyFinancialIntegrity(w.db)).failures).toEqual([]);
  });

  it('opt-in unique-amount policy: exactly one pending order with that amount in its window matches; several are ambiguous; none is unmatched', async () => {
    await w.db.close();
    w = await boot({ ingest: { matchPolicy: 'unique_amount_window' } });
    const solo = await newOrder(w, 77_700);
    const r1 = nextRef();
    expect((await ingest(w, await makeAlert({ amountMinor: 77_700, reference: r1 }))).creditStatus).toBe('MATCHED');
    expect((await creditRow(w, r1)).match_method).toBe('UNIQUE_AMOUNT_IN_WINDOW');
    expect((await orderRow(w, solo.id)).status).toBe('PAID');

    const t1 = await newOrder(w, 55_500);
    const t2 = await newOrder(w, 55_500);
    const r2 = nextRef();
    expect((await ingest(w, await makeAlert({ amountMinor: 55_500, reference: r2 }))).creditStatus).toBe('AMBIGUOUS');
    expect((await orderRow(w, t1.id)).status).toBe('PENDING');
    expect((await orderRow(w, t2.id)).status).toBe('PENDING');

    expect((await ingest(w, await makeAlert({ amountMinor: 11_100, reference: nextRef() }))).creditStatus).toBe('UNMATCHED');
  });
});

describe('templates gate everything', () => {
  beforeEach(async () => {
    w = await boot({ activateTemplate: false });
  });

  it('cannot be activated before it has parsed a real sample, and a sample that does not parse is refused', async () => {
    await expect(w.p.alertTemplates.activate(w.admin, w.templateId)).rejects.toMatchObject({ code: 'NOT_VALIDATED' });
    await expect(w.p.alertTemplates.validateWithSample(w.admin, w.templateId, { subject: '', text: 'Your statement is ready' })).rejects.toMatchObject({ code: 'SAMPLE_DOES_NOT_PARSE', status: 422 });
    expect((await w.db.query<any>('SELECT status, validated_at FROM alert_templates'))[0]).toMatchObject({ status: 'DRAFT', validated_at: null });
  });

  it('refuses unusable definitions and duplicate names; a dry-run test writes nothing', async () => {
    await expect(w.p.alertTemplates.create(w.admin, { name: 'bad', bankName: 'X', definition: { ...TEMPLATE_DEFINITION, creditRegex: '' } })).rejects.toMatchObject({ code: 'INVALID_TEMPLATE' });
    await expect(w.p.alertTemplates.create(w.admin, { name: 'testbank-credit', bankName: 'X', definition: TEMPLATE_DEFINITION })).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS' });
    const t = w.p.alertTemplates.testDefinition(TEMPLATE_DEFINITION, { subject: '', text: 'Rs. 5.00 credited to your a/c XX1 on 01-01-2026 10:00:00 Ref No 123456789012' });
    expect(t).toMatchObject({ ok: true, credit: { amountMinor: 500, reference: '123456789012' } });
    expect(await creditsCount()).toBe(0);
  });

  describe('once active', () => {
    beforeEach(async () => {
      await w.p.alertTemplates.validateWithSample(w.admin, w.templateId, { subject: '', text: 'Rs. 100.00 credited to your a/c XX1 on 01-01-2026 10:00:00 Ref No 111111111111' });
      await w.p.alertTemplates.activate(w.admin, w.templateId);
    });

    it('debits and reversals are ignored (never credited)', async () => {
      const o = await newOrder(w);
      expect(await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, verb: 'debited' }))).toMatchObject({ status: 'IGNORED' });
      expect(await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, verb: 'reversal' }))).toMatchObject({ status: 'IGNORED', reason: 'DEBIT_OR_REVERSAL_MARKER' });
      expect(await creditsCount()).toBe(0);
    });

    it.each(['reference', 'timestamp', 'amount'] as const)('an authenticated credit-like email with a missing %s is UNPARSEABLE, raises an alert and credits nothing', async (omit) => {
      const o = await newOrder(w);
      const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id, omit }));
      expect(out.status).toBe('UNPARSEABLE');
      expect(out.reason).toContain(`FIELD_MISSING:${omit}`);
      expect((await w.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['BANK_EMAIL_UNPARSEABLE'])).length).toBe(1);
      expect(await creditsCount()).toBe(0);
      expect((await orderRow(w, o.id)).status).toBe('PENDING');
    });

    it('stores alert text encrypted, shows it masked to reviewers (audited), and never keeps it in clear', async () => {
      const o = await newOrder(w);
      const out = await ingest(w, await makeAlert({ amountMinor: 125_000, orderId: o.provider_order_id }));
      const dump = JSON.stringify(await w.db.query('SELECT * FROM mail_messages'));
      expect(dump).not.toContain('payer.one');
      expect(dump).not.toContain('XX1234');
      const t = await w.p.collections.messageText(out.messageId!, w.admin);
      expect(t.text).toContain('credited');
      expect(t.text).not.toContain('payer.one@okhdfc'); // masked
      expect((await w.db.query('SELECT 1 FROM audit_logs WHERE action=$1', ['bankmail.message_viewed'])).length).toBe(1);
    });
  });
});

describe('retry after an unexpected failure', () => {
  beforeEach(async () => {
    w = await boot();
  });

  it('a crash after the credit was recorded leaves it NEW; the sweeper finishes it exactly once, and the message is retried with backoff', async () => {
    const o = await newOrder(w);
    const ref = nextRef();
    const raw = await makeAlert({ amountMinor: 125_000, reference: ref, orderId: o.provider_order_id });
    const orig = w.p.verification.applyProviderPayment.bind(w.p.verification);
    let failOnce = true;
    w.p.verification.applyProviderPayment = async (pp) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated crash before the payment was applied');
      }
      return orig(pp);
    };
    const out = await ingest(w, raw, 'retry-1');
    expect(out.status).toBe('ERROR');
    const [m] = await w.db.query<any>(`SELECT status, attempts, next_retry_at FROM mail_messages WHERE source_message_id='retry-1'`);
    expect(m).toMatchObject({ status: 'ERROR', attempts: 1 });
    expect(new Date(m.next_retry_at).getTime()).toBeGreaterThan(Date.now());
    expect((await creditRow(w, ref)).status).toBe('NEW'); // evidence recorded, not yet applied
    expect((await orderRow(w, o.id)).status).toBe('PENDING');

    // later: the message is due again, and the unfinished credit is picked up
    await w.db.query(`UPDATE bank_credits SET created_at = now() - interval '5 minutes'`);
    expect(await w.p.ingest.matchNew()).toBe(1);
    expect((await orderRow(w, o.id)).status).toBe('PAID');
    const retried = await ingest(w, raw, 'retry-1'); // the mail row is in ERROR so it is processed again: the duplicate reference changes nothing
    expect(['DUPLICATE', 'ALREADY_SEEN']).toContain(retried.status);
    expect(await paymentsCount()).toBe(1);
    expect(await payable()).toBe(122_500);
    expect(await w.p.ingest.matchNew()).toBe(0);
  });
});
