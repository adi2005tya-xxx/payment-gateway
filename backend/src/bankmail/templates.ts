import { DomainError } from '../common/errors';

/**
 * A bank alert template is DATA supplied by the operator from the bank's REAL emails. No bank format is built into this software.
 * Regexes are matched against the alert text after whitespace is collapsed to single spaces (so write them for one line of text).
 */
export interface FieldRule {
  regex: string;
  /** capture group to use (default 1) */
  group?: number;
  flags?: string;
}
export interface TimestampRule extends FieldRule {
  /** e.g. "DD-MM-YYYY HH:mm:ss" or "DD MMM YYYY hh:mm A". Tokens: YYYY YY MMM MM M DD D HH H hh h mm ss A */
  format: string;
  /** offset of the timestamps in the email, default +05:30 (IST) */
  utcOffset?: string;
}
export interface TemplateDefinition {
  /**
   * 'email' (default): DKIM-authenticated email. 'notification': text forwarded from the owner's phone (a push notification or SMS).
   * Phone text carries NO cryptographic proof and usually no order reference: it is weaker evidence, labelled as such, and limited.
   */
  channel?: 'email' | 'notification';
  /** email: exact sender addresses the bank uses (lower case) */
  fromAddresses?: string[];
  /** email: DKIM signing domains accepted for this bank; the From address domain must be this domain or a subdomain of it */
  dkimDomains?: string[];
  /** notification: Android package names whose notifications are accepted, e.g. com.phonepe.business */
  packages?: string[];
  /** notification: SMS sender ids accepted */
  smsSenders?: string[];
  /** notification: the text has no credit time; use the moment the phone posted it (checked for freshness against the server clock) */
  useReceiptTime?: boolean;
  subjectRegex?: string;
  /** the body must match this to be treated as a CREDIT */
  creditRegex: string;
  /** if any matches, the email is NOT a credit (debits, reversals, failed/pending notices...) */
  rejectRegexes?: string[];
  amount: FieldRule;
  /** the bank's transaction reference (e.g. UTR/RRN). Used for de-duplication, so it must be unique per credit. */
  reference: FieldRule;
  timestamp?: TimestampRule;
  payer?: FieldRule;
  /** optional explicit order reference field; otherwise order ids (GW + 10 chars) are looked for anywhere in the text */
  orderRef?: FieldRule;
  maxAmountMinor?: number;
}

export interface ParsedCredit {
  amountMinor: number;
  reference: string;
  creditedAt: Date;
  payerMasked: string | null;
  orderTokens: string[];
}

export type ParseResult = { ok: true; credit: ParsedCredit } | { ok: false; reason: string; kind: 'NOT_A_CREDIT' | 'UNPARSEABLE' };

const MAX_TEXT = 20_000;
const MAX_PATTERN = 500;
export const ORDER_TOKEN = /\bGW[A-Z2-9]{10}\b/g;

export const normaliseText = (s: string) => s.replace(/\s+/g, ' ').trim();

function compile(rule: string, flags = 'i'): RegExp {
  if (!rule || rule.length > MAX_PATTERN) throw new DomainError('INVALID_TEMPLATE', 'Regex missing or too long');
  try {
    return new RegExp(rule, flags.replace(/[gy]/g, ''));
  } catch {
    throw new DomainError('INVALID_TEMPLATE', `Invalid regular expression: ${rule.slice(0, 60)}`);
  }
}

/** Throws DomainError if the definition is unusable. Called when a template is created. */
export function validateDefinition(def: any): TemplateDefinition {
  const bad = (m: string) => new DomainError('INVALID_TEMPLATE', m);
  if (!def || typeof def !== 'object') throw bad('definition must be an object');
  const channel = def.channel ?? 'email';
  if (!['email', 'notification'].includes(channel)) throw bad('channel must be email or notification');
  const list = (v: unknown, name: string) => {
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x.trim())) throw bad(`${name} must be a non-empty list`);
    return (v as string[]).map((x) => x.trim().toLowerCase());
  };
  const out: any = { ...def, channel };
  if (channel === 'email') {
    const fromAddresses = list(def.fromAddresses, 'fromAddresses');
    if (fromAddresses.some((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))) throw bad('fromAddresses must be full email addresses');
    const dkimDomains = list(def.dkimDomains, 'dkimDomains');
    if (dkimDomains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw bad('dkimDomains must be domain names');
    out.fromAddresses = fromAddresses;
    out.dkimDomains = dkimDomains;
    if (def.useReceiptTime) throw bad('useReceiptTime is only for phone notifications; emails must carry the credit time');
  } else {
    const packages = def.packages === undefined ? [] : list(def.packages, 'packages');
    const smsSenders = def.smsSenders === undefined ? [] : list(def.smsSenders, 'smsSenders');
    if (!packages.length && !smsSenders.length) throw bad('a notification template needs packages and/or smsSenders');
    if (packages.some((x) => !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(x))) throw bad('packages must look like com.example.app');
    if (smsSenders.some((x) => !/^[a-z0-9-]{2,20}$/.test(x))) throw bad('smsSenders must be sender ids such as ad-phonepe');
    out.packages = packages;
    out.smsSenders = smsSenders;
    if (!def.maxAmountMinor) throw bad('a notification template must set maxAmountMinor (a ceiling for unverified evidence)');
  }
  for (const f of ['amount', 'reference']) if (!def[f]?.regex) throw bad(`${f}.regex is required`);
  if (!def.creditRegex) throw bad('creditRegex is required (it is how a credit is told apart from a debit)');
  const needsTimestamp = !(channel === 'notification' && def.useReceiptTime);
  if (needsTimestamp && (!def.timestamp?.regex || !def.timestamp?.format)) throw bad('timestamp.regex and timestamp.format are required');
  const rules: Array<[string, string | undefined]> = [
    ['creditRegex', def.creditRegex], ['subjectRegex', def.subjectRegex], ['amount', def.amount.regex], ['reference', def.reference.regex],
    ['timestamp', def.timestamp?.regex], ['payer', def.payer?.regex], ['orderRef', def.orderRef?.regex],
    ...((def.rejectRegexes ?? []) as string[]).map((r, i) => [`rejectRegexes[${i}]`, r] as [string, string]),
  ];
  for (const [, r] of rules) if (r) compile(r);
  if (def.timestamp?.format) timestampMatcher(def.timestamp.format); // throws on bad format
  if (def.maxAmountMinor !== undefined && (!Number.isSafeInteger(def.maxAmountMinor) || def.maxAmountMinor <= 0)) throw bad('maxAmountMinor must be a positive integer');
  return out as TemplateDefinition;
}

/** "Rs. 1,250.00", "INR 1250.5", "₹ 99" -> paise. No floating point. Returns null if not a plain amount. */
export function parseAmountMinor(raw: string): number | null {
  const s = raw.replace(/(?:rs\.?|inr|₹)/gi, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ''] = s.split('.');
  const v = Number(r) * 100 + Number(p.padEnd(2, '0'));
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const TOKENS = ['YYYY', 'MMM', 'YY', 'MM', 'DD', 'HH', 'hh', 'mm', 'ss', 'M', 'D', 'H', 'h', 'A'];

function timestampMatcher(format: string): { re: RegExp; order: string[] } {
  let re = '';
  const order: string[] = [];
  for (let i = 0; i < format.length; ) {
    const t = TOKENS.find((k) => format.startsWith(k, i));
    if (!t) {
      re += format[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
      continue;
    }
    order.push(t);
    re += t === 'YYYY' ? '(\\d{4})' : t === 'MMM' ? '([A-Za-z]{3})' : t === 'A' ? '([AaPp][Mm])' : t === 'YY' || t.length === 2 ? '(\\d{2})' : '(\\d{1,2})';
    i += t.length;
  }
  if (!order.length) throw new DomainError('INVALID_TEMPLATE', 'timestamp.format has no date/time tokens');
  if (!order.some((o) => ['YYYY', 'YY'].includes(o)) || !order.some((o) => ['MM', 'M', 'MMM'].includes(o)) || !order.some((o) => ['DD', 'D'].includes(o))) {
    throw new DomainError('INVALID_TEMPLATE', 'timestamp.format must include year, month and day');
  }
  return { re: new RegExp(`^${re}$`), order };
}

/** Parses the matched timestamp text with the template's format; returns the instant as a Date, or null if impossible. */
export function parseTimestamp(text: string, format: string, utcOffset = '+05:30'): Date | null {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  if (!m) return null;
  const offMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const { re, order } = timestampMatcher(format);
  const g = re.exec(text.trim());
  if (!g) return null;
  let Y = 0, Mo = 0, D = 0, H = 0, Mi = 0, S = 0;
  let pm: boolean | null = null;
  order.forEach((t, i) => {
    const v = g[i + 1];
    if (t === 'YYYY') Y = Number(v);
    else if (t === 'YY') Y = 2000 + Number(v);
    else if (t === 'MMM') Mo = MONTHS.indexOf(v.toLowerCase()) + 1;
    else if (t === 'MM' || t === 'M') Mo = Number(v);
    else if (t === 'DD' || t === 'D') D = Number(v);
    else if (t === 'HH' || t === 'H' || t === 'hh' || t === 'h') H = Number(v);
    else if (t === 'mm') Mi = Number(v);
    else if (t === 'ss') S = Number(v);
    else if (t === 'A') pm = /^p/i.test(v);
  });
  if (pm !== null) {
    if (H < 1 || H > 12) return null;
    H = (H % 12) + (pm ? 12 : 0);
  }
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59 || Y < 2000) return null;
  const ms = Date.UTC(Y, Mo - 1, D, H, Mi, S) - offMin * 60_000;
  const d = new Date(ms);
  // reject impossible dates such as 31 Feb that Date.UTC would roll over
  const local = new Date(ms + offMin * 60_000);
  if (local.getUTCFullYear() !== Y || local.getUTCMonth() !== Mo - 1 || local.getUTCDate() !== D) return null;
  return d;
}

function field(rule: FieldRule, text: string): string | null {
  const m = compile(rule.regex, rule.flags).exec(text);
  if (!m) return null;
  const v = m[rule.group ?? 1];
  return v === undefined ? null : v.trim();
}

const maskPayer = (p: string) => (p.includes('@') ? `${p.split('@')[0].slice(0, 2)}****@${p.split('@')[1]}` : p.length > 4 ? `${p.slice(0, 2)}****${p.slice(-2)}` : '****');

/**
 * Applies a template to an alert's subject and text. Pure function: it decides nothing about authenticity (see authenticity.ts)
 * and never guesses: any missing or malformed field makes the whole alert unparseable.
 */
export function parseAlert(def: TemplateDefinition, input: { subject: string; text: string; receivedAt?: Date }): ParseResult {
  // Phone notifications may use styled Unicode digits (e.g. double-struck) that look like 2.3 but are not ASCII: fold them (NFKC).
  const fold = def.channel === 'notification' ? (v: string) => v.normalize('NFKC') : (v: string) => v;
  const text = normaliseText(fold(input.text)).slice(0, MAX_TEXT);
  const subject = normaliseText(fold(input.subject ?? ''));
  if (def.subjectRegex && !compile(def.subjectRegex).test(subject)) return { ok: false, kind: 'NOT_A_CREDIT', reason: 'SUBJECT_DOES_NOT_MATCH' };
  for (const r of def.rejectRegexes ?? []) if (compile(r).test(text) || compile(r).test(subject)) return { ok: false, kind: 'NOT_A_CREDIT', reason: 'DEBIT_OR_REVERSAL_MARKER' };
  if (!compile(def.creditRegex).test(text)) return { ok: false, kind: 'NOT_A_CREDIT', reason: 'NOT_A_CREDIT_ALERT' };

  const amountRaw = field(def.amount, text);
  if (amountRaw === null) return { ok: false, kind: 'UNPARSEABLE', reason: 'FIELD_MISSING:amount' };
  const amountMinor = parseAmountMinor(amountRaw);
  if (amountMinor === null) return { ok: false, kind: 'UNPARSEABLE', reason: 'BAD_AMOUNT' };
  if (def.maxAmountMinor && amountMinor > def.maxAmountMinor) return { ok: false, kind: 'UNPARSEABLE', reason: 'AMOUNT_ABOVE_TEMPLATE_MAXIMUM' };

  const reference = field(def.reference, text);
  if (!reference || reference.length < 6 || reference.length > 64 || !/^[A-Za-z0-9/_-]+$/.test(reference)) return { ok: false, kind: 'UNPARSEABLE', reason: reference ? 'BAD_REFERENCE' : 'FIELD_MISSING:reference' };

  let creditedAt: Date | null;
  if (def.timestamp?.regex) {
    const tsRaw = field(def.timestamp, text);
    if (tsRaw === null) return { ok: false, kind: 'UNPARSEABLE', reason: 'FIELD_MISSING:timestamp' };
    creditedAt = parseTimestamp(tsRaw, def.timestamp.format, def.timestamp.utcOffset);
    if (!creditedAt) return { ok: false, kind: 'UNPARSEABLE', reason: 'BAD_TIMESTAMP' };
  } else if (def.useReceiptTime && input.receivedAt) {
    creditedAt = input.receivedAt;
  } else {
    return { ok: false, kind: 'UNPARSEABLE', reason: 'FIELD_MISSING:timestamp' };
  }

  const payer = def.payer ? field(def.payer, text) : null;
  const tokens = new Set<string>();
  for (const m of text.toUpperCase().matchAll(ORDER_TOKEN)) tokens.add(m[0]);
  if (def.orderRef) {
    const o = field(def.orderRef, text);
    if (o) for (const m of o.toUpperCase().matchAll(ORDER_TOKEN)) tokens.add(m[0]);
  }
  return { ok: true, credit: { amountMinor, reference, creditedAt, payerMasked: payer ? maskPayer(payer) : null, orderTokens: [...tokens] } };
}
