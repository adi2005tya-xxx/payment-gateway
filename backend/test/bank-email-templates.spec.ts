import { normaliseText, parseAlert, parseAmountMinor, parseTimestamp, validateDefinition } from '../src/bankmail/templates';
import { TEMPLATE_DEFINITION } from './bank-email-helpers';

// Fixtures are SYNTHETIC (see bank-email-helpers.ts); they are not any real bank's format.
const def = validateDefinition(TEMPLATE_DEFINITION);
const body = (extra = '') => `Dear Customer, Rs. 1,250.00 credited to your a/c XX1234 on 13-10-2026 11:02:33 by UPI. Ref No 612345678901. Remark: Order GWABCDEFGH23. VPA payer.one@okhdfc. ${extra}`;

describe('amount parsing is exact integer arithmetic', () => {
  it.each([
    ['Rs. 1,250.00', 125000], ['INR 1250.5', 125050], ['₹ 99', 9900], ['Rs.0.05', 5], ['1,00,000.00', 10000000], ['rs 10', 1000],
  ])('%s -> %i paise', (raw, minor) => expect(parseAmountMinor(raw)).toBe(minor));
  it.each(['0', '0.00', '12.345', 'abc', '-5', '1e5', '', 'Rs.', '1.2.3', '१२३'])('rejects %j', (raw) => expect(parseAmountMinor(raw)).toBeNull());
});

describe('timestamp parsing', () => {
  it('reads the bank clock in IST by default and returns the true instant', () => {
    expect(parseTimestamp('13-10-2026 11:02:33', 'DD-MM-YYYY HH:mm:ss')!.toISOString()).toBe('2026-10-13T05:32:33.000Z');
  });
  it('supports month names, 12-hour clocks and explicit offsets', () => {
    expect(parseTimestamp('13 Oct 2026 11:02 PM', 'DD MMM YYYY hh:mm A')!.toISOString()).toBe('2026-10-13T17:32:00.000Z');
    expect(parseTimestamp('13 Oct 2026 12:05 AM', 'DD MMM YYYY hh:mm A')!.toISOString()).toBe('2026-10-12T18:35:00.000Z');
    expect(parseTimestamp('13 Oct 2026 12:05 PM', 'DD MMM YYYY hh:mm A')!.toISOString()).toBe('2026-10-13T06:35:00.000Z');
    expect(parseTimestamp('2026-10-13 10:00:00', 'YYYY-MM-DD HH:mm:ss', '+00:00')!.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(parseTimestamp('13/10/26 9:05', 'DD/MM/YY H:mm')!.toISOString()).toBe('2026-10-13T03:35:00.000Z');
  });
  it.each([['31-02-2026 10:00:00'], ['13-13-2026 10:00:00'], ['13-10-2026 25:00:00'], ['13-10-2026 10:61:00'], ['00-10-2026 10:00:00'], ['not a date']])('rejects %s', (t) => {
    expect(parseTimestamp(t, 'DD-MM-YYYY HH:mm:ss')).toBeNull();
  });
  it('rejects an invalid 12-hour value and a bad offset', () => {
    expect(parseTimestamp('13 Oct 2026 13:00 PM', 'DD MMM YYYY hh:mm A')).toBeNull();
    expect(parseTimestamp('13-10-2026 10:00:00', 'DD-MM-YYYY HH:mm:ss', 'IST')).toBeNull();
  });
});

describe('template definitions are validated', () => {
  const bad = (patch: any) => () => validateDefinition({ ...TEMPLATE_DEFINITION, ...patch });
  it('accepts a good definition and normalises sender case', () => {
    expect(validateDefinition({ ...TEMPLATE_DEFINITION, fromAddresses: ['Alerts@TestBank.Example'] }).fromAddresses).toEqual(['alerts@testbank.example']);
  });
  it.each([
    ['no creditRegex', { creditRegex: '' }],
    ['broken regex', { amount: { regex: '([' } }],
    ['sender not an email', { fromAddresses: ['testbank.example'] }],
    ['no dkim domains', { dkimDomains: [] }],
    ['dkim domain not a domain', { dkimDomains: ['not a domain'] }],
    ['timestamp without year', { timestamp: { regex: 'x', format: 'DD-MM HH:mm' } }],
    ['no reference rule', { reference: undefined }],
    ['huge regex', { reference: { regex: 'a'.repeat(600) } }],
    ['bad maximum', { maxAmountMinor: -1 }],
  ])('rejects %s', (_n, patch) => expect(bad(patch)).toThrow(/INVALID_TEMPLATE|Regex|required|must|Invalid regular/i));
});

describe('alert parsing never guesses', () => {
  it('extracts amount, reference, time, masked payer and order ids from a credit', () => {
    const r = parseAlert(def, { subject: 'Credit alert', text: body() });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.credit).toMatchObject({ amountMinor: 125000, reference: '612345678901', payerMasked: 'pa****@okhdfc', orderTokens: ['GWABCDEFGH23'] });
    expect(r.credit.creditedAt.toISOString()).toBe('2026-10-13T05:32:33.000Z');
  });
  it('collapses whitespace so multi-line emails parse', () => {
    expect(parseAlert(def, { subject: '', text: body().replace(/ /g, '\n  ') })).toMatchObject({ ok: true });
    expect(normaliseText(' a \n\n b ')).toBe('a b');
  });
  it.each([
    ['a debit', body().replace('credited to your a/c', 'debited from your a/c'), 'DEBIT_OR_REVERSAL_MARKER'],
    ['a reversal', body('Reversal of earlier transaction.'), 'DEBIT_OR_REVERSAL_MARKER'],
    ['a failed notice', body('Transaction failed.'), 'DEBIT_OR_REVERSAL_MARKER'],
    ['an unrelated email', 'Your statement is ready.', 'NOT_A_CREDIT_ALERT'],
  ])('treats %s as NOT a credit', (_n, text, reason) => expect(parseAlert(def, { subject: '', text })).toMatchObject({ ok: false, kind: 'NOT_A_CREDIT', reason }));
  it.each([
    ['missing amount', body().replace('Rs. 1,250.00 credited', 'An amount credited'), 'FIELD_MISSING:amount'],
    ['missing reference', body().replace('Ref No 612345678901.', ''), 'FIELD_MISSING:reference'],
    ['missing time', body().replace('on 13-10-2026 11:02:33', ''), 'FIELD_MISSING:timestamp'],
    ['impossible date', body().replace('13-10-2026', '31-02-2026'), 'BAD_TIMESTAMP'],
    ['zero amount', body().replace('1,250.00', '0.00'), 'BAD_AMOUNT'],
    ['three-decimal amount (the strict amount pattern refuses it)', body().replace('1,250.00', '1,250.005'), 'FIELD_MISSING:amount'],
  ])('is unparseable with %s', (_n, text, reason) => expect(parseAlert(def, { subject: '', text })).toMatchObject({ ok: false, kind: 'UNPARSEABLE', reason }));
  it('enforces the subject pattern and the amount ceiling when configured', () => {
    const strict = validateDefinition({ ...TEMPLATE_DEFINITION, subjectRegex: '^Credit alert$', maxAmountMinor: 100000 });
    expect(parseAlert(strict, { subject: 'Something else', text: body() })).toMatchObject({ ok: false, reason: 'SUBJECT_DOES_NOT_MATCH' });
    expect(parseAlert(strict, { subject: 'Credit alert', text: body() })).toMatchObject({ ok: false, reason: 'AMOUNT_ABOVE_TEMPLATE_MAXIMUM' });
  });
});
