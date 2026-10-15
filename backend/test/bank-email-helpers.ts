import { createServer, Server } from 'http';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'crypto';
import { dkimSign, dkimVerify } from 'mailauth';
import { migrate } from '../src/db/db';
import { PgliteDb } from '../src/db/pglite.db';
import { Actor } from '../src/audit/audit.service';
import { createPlatform, OpsOptions, Platform } from '../src/platform';
import { BankEmailProvider } from '../src/provider/bank-email.provider';
import { MemoryNotifier } from '../src/ops/notifications';
import { IngestOptions } from '../src/bankmail/ingest.service';
import { testSecurity } from './helpers';

/*
 * ALL FIXTURES HERE ARE SYNTHETIC. "TestBank" and its alert wording are invented for these tests so the parser/matcher can be exercised.
 * They are NOT the format of any real bank. A real deployment defines its template from the operator's own real emails.
 */
export const BANK_DOMAIN = 'testbank.example';
export const BANK_FROM = 'alerts@testbank.example';

const bankKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const attackerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const pemOf = (k: typeof bankKey) => k.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const pubB64 = (k: typeof bankKey) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** DNS stub: the bank's DKIM key is published at s1._domainkey.testbank.example; the attacker publishes theirs under their own domain. */
export const dnsResolver = async (name: string, rr: string) => {
  if (rr === 'TXT' && name === `s1._domainkey.${BANK_DOMAIN}`) return [[`v=DKIM1; k=rsa; p=${pubB64(bankKey)}`]];
  if (rr === 'TXT' && name === 's1._domainkey.evil.example') return [[`v=DKIM1; k=rsa; p=${pubB64(attackerKey)}`]];
  const e: any = new Error('NXDOMAIN');
  e.code = 'ENOTFOUND';
  throw e;
};

export const TEMPLATE_DEFINITION = {
  fromAddresses: [BANK_FROM],
  dkimDomains: [BANK_DOMAIN],
  creditRegex: 'credited to your a/c',
  rejectRegexes: ['debited', 'reversal', 'failed'],
  amount: { regex: 'Rs\\.? ?([\\d,]+(?:\\.\\d{1,2})?) credited' },
  reference: { regex: 'Ref No (\\d{12})' },
  timestamp: { regex: 'on (\\d{2}-\\d{2}-\\d{4} \\d{2}:\\d{2}:\\d{2})', format: 'DD-MM-YYYY HH:mm:ss', utcOffset: '+05:30' },
  payer: { regex: 'VPA ([\\w.-]+@\\w+)' },
};

const pad = (n: number) => String(n).padStart(2, '0');
/** Formats an instant the way the synthetic TestBank prints it (IST). */
export function istStamp(d: Date): string {
  const t = new Date(d.getTime() + 330 * 60_000);
  return `${pad(t.getUTCDate())}-${pad(t.getUTCMonth() + 1)}-${t.getUTCFullYear()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

export interface AlertOpts {
  amountMinor: number;
  reference?: string;
  orderId?: string | string[] | null;
  at?: Date;
  /** body wording */
  verb?: 'credited' | 'debited' | 'reversal';
  /** raw From header */
  fromHeader?: string;
  subject?: string;
  sign?: false | { domain: string; selector?: string; key?: typeof bankKey; headerList?: string[]; maxBodyLength?: number };
  extraHeaders?: string[];
  extraBody?: string;
  omit?: 'reference' | 'timestamp' | 'amount';
}
const rupees = (m: number) => (m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let refCounter = 612345000000;
export const nextRef = () => String(++refCounter);

async function buildAlert(o: AlertOpts): Promise<Buffer> {
  const at = o.at ?? new Date();
  const orders = o.orderId ? (Array.isArray(o.orderId) ? o.orderId : [o.orderId]) : [];
  const verb = o.verb ?? 'credited';
  const bits = [
    'Dear Customer,',
    o.omit === 'amount' ? 'An amount credited to your a/c XX1234' : `Rs. ${rupees(o.amountMinor)} ${verb === 'credited' ? 'credited to your a/c XX1234' : verb === 'debited' ? 'debited from your a/c XX1234' : 'credited to your a/c XX1234 (reversal)'}`,
    o.omit === 'timestamp' ? '' : `on ${istStamp(at)}`,
    'by UPI.',
    o.omit === 'reference' ? '' : `Ref No ${o.reference ?? nextRef()}.`,
    orders.length ? `Remark: ${orders.map((x) => `Order ${x}`).join(' ')}.` : '',
    'VPA payer.one@okhdfc.',
    o.extraBody ?? '',
    '-TestBank',
  ].filter(Boolean);
  const msg =
    `From: ${o.fromHeader ?? `"TestBank Alerts" <${BANK_FROM}>`}\r\nTo: owner@example.test\r\nSubject: ${o.subject ?? 'Credit alert'}\r\n` +
    `Date: ${at.toUTCString()}\r\nMessage-ID: <${randomBytes(8).toString('hex')}@${BANK_DOMAIN}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n` +
    `${(o.extraHeaders ?? []).map((h) => h + '\r\n').join('')}\r\n${bits.join(' ')}\r\n`;
  const sign = o.sign === undefined ? { domain: BANK_DOMAIN } : o.sign;
  if (!sign) return Buffer.from(msg);
  const res = await dkimSign(msg, {
    headerList: sign.headerList,
    signatureData: [{ signingDomain: sign.domain, selector: sign.selector ?? 's1', privateKey: pemOf(sign.key ?? bankKey), ...(sign.maxBodyLength ? { maxBodyLength: sign.maxBodyLength } : {}) }],
  } as any);
  return Buffer.from(res.signatures + msg);
}

/**
 * Fixture builder. NOTE (found by independent verification written from RFC 6376): the DKIM signing library used here occasionally
 * (~0.25% of messages) emits a signature that does not verify, while the verifier is correct. Fixtures that are SUPPOSED to be
 * genuinely signed therefore verify themselves and are rebuilt (new Message-ID) until the signature is valid. This affects only
 * test fixtures; intentionally forged fixtures are left exactly as built.
 */
export async function makeAlert(o: AlertOpts): Promise<Buffer> {
  const sign = o.sign === undefined ? { domain: BANK_DOMAIN } : o.sign;
  const shouldVerify = !!sign && !sign.maxBodyLength && (sign.selector ?? 's1') === 's1' && !sign.headerList && (sign.key === undefined || (sign.domain === 'evil.example' && sign.key === attackerKey)) && [BANK_DOMAIN, 'evil.example', 'gmail.example'].includes(sign.domain);
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await buildAlert(o);
    if (!shouldVerify) return raw;
    const r = await dkimVerify(raw, { resolver: dnsResolver } as any);
    if (r.results?.some((x: any) => x.status?.result === 'pass')) return raw;
    // gmail.example has no DNS key in the stub, so it can never verify: do not loop on it
    if (sign.domain === 'gmail.example') return raw;
  }
  throw new Error('could not build a validly signed fixture');
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

/**
 * Hand-made DKIM-Signature (relaxed/relaxed, rsa-sha256) over exactly the headers listed, so a test can build a signature that does
 * NOT cover From (the signing library always signs From). The signature is cryptographically valid for what it covers.
 */
export function signCustom(message: Buffer, o: { domain: string; selector?: string; key?: typeof bankKey; signedHeaders: string[] }): Buffer {
  const text = message.toString('latin1');
  const split = text.indexOf(CRLF + CRLF);
  const head = text.slice(0, split).replace(new RegExp(CRLF + '[ \\t]+', 'g'), ' ');
  const body = text.slice(split + 4);
  const headers = head.split(CRLF).map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim().replace(/[ \t]+/g, ' ')] as [string, string]);
  const canonBody = (() => {
    let b = body.split(CRLF).map((l) => l.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' ')).join(CRLF);
    b = b.replace(new RegExp('(' + CRLF + ')+$'), '');
    return b.length ? b + CRLF : '';
  })();
  const bh = createHash('sha256').update(canonBody).digest('base64');
  const sel = o.selector ?? 's1';
  const base = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${o.domain}; s=${sel}; h=${o.signedHeaders.join(':')}; bh=${bh}; b=`;
  const canonHeaders = o.signedHeaders.map((n) => `${n}:${headers.filter(([k]) => k === n).pop()?.[1] ?? ''}${CRLF}`).join('');
  const toSign = canonHeaders + `dkim-signature:${base}`;
  const signer = createSign('RSA-SHA256');
  signer.update(toSign);
  const b = signer.sign(pemOf(o.key ?? bankKey)).toString('base64');
  return Buffer.from(`DKIM-Signature: ${base}${b}${CRLF}` + text, 'latin1');
}

export interface World {
  db: PgliteDb;
  p: Platform;
  provider: BankEmailProvider;
  notifier: MemoryNotifier;
  admin: Actor;
  admin2: Actor;
  merchantId: string;
  merchantActor: Actor;
  templateId: string;
  setNow(d: Date | null): void;
}

export async function boot(opts: { ingest?: Partial<IngestOptions>; ops?: OpsOptions; activateTemplate?: boolean; grace?: number } = {}): Promise<World> {
  const db = await PgliteDb.open();
  await migrate(db);
  const provider = new BankEmailProvider(db, 'http://localhost:3001', 60, opts.grace ?? 60);
  const notifier = new MemoryNotifier();
  let fixedNow: Date | null = null;
  const p = createPlatform(db, provider, testSecurity(() => new Date()), {
    notifier,
    ...(opts.ops ?? {}),
    bankmail: { ...(opts.ops?.bankmail ?? {}), ingest: { resolver: dnsResolver, now: () => fixedNow ?? new Date(), ...(opts.ingest ?? {}) } },
  });
  const mk = async (email: string): Promise<Actor> => {
    const [u] = await db.query<any>(`INSERT INTO users(email, password_hash, role) VALUES ($1,'x','ADMIN') RETURNING id`, [email]);
    return { id: u.id, role: 'ADMIN' };
  };
  const admin = await mk('a1@example.test');
  const admin2 = await mk('a2@example.test');
  const reg = await p.merchants.register({ email: 'shop@example.test', passwordHash: 'x', legalName: 'Shop Pvt Ltd', displayName: 'Shop' });
  await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', admin);
  const merchantActor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
  const t = await p.alertTemplates.create(admin, { name: 'testbank-credit', bankName: 'TestBank (synthetic)', definition: TEMPLATE_DEFINITION });
  if (opts.activateTemplate !== false) {
    await p.alertTemplates.validateWithSample(admin, t.id, { subject: 'Credit alert', text: 'Dear Customer, Rs. 100.00 credited to your a/c XX1234 on 01-01-2026 10:00:00 by UPI. Ref No 111111111111. VPA a@b. -TestBank' });
    await p.alertTemplates.activate(admin, t.id);
  }
  return { db, p, provider, notifier, admin, admin2, merchantId: reg.merchantId, merchantActor, templateId: t.id, setNow: (d) => (fixedNow = d) };
}

export async function newOrder(w: World, amountMinor = 125_000, opts: { minutes?: number; payee?: string } = {}) {
  return w.p.requests.create(
    w.merchantId,
    { orderReference: `ORD-${randomBytes(4).toString('hex')}`, amountMinor, expiresInMinutes: opts.minutes ?? 30, payeeVpa: opts.payee ?? 'owner.shop@okhdfc' },
    w.merchantActor,
  );
}

export const orderRow = async (w: World, id: string) => (await w.db.query<any>('SELECT * FROM payment_requests WHERE id=$1', [id]))[0];
export const creditRow = async (w: World, ref: string) => (await w.db.query<any>('SELECT * FROM bank_credits WHERE reference=$1', [ref]))[0];

let seq = 0;
export const ingest = (w: World, raw: Buffer, id = `m${++seq}`, receivedAt = new Date()) => w.p.ingest.ingestRaw(raw, { source: 'test', sourceMessageId: id, receivedAt });

/** Minimal mock of Google's OAuth + Gmail endpoints. */
export interface MockGoogle {
  server: Server;
  url: string;
  state: {
    messages: Map<string, { raw: Buffer; internalDate: number }>;
    scope: string;
    refreshToken: string;
    listCalls: string[];
    tokenCalls: Array<Record<string, string>>;
    revoked: string[];
    failList: number; // next N list calls answer 503
    listStatus: number | null; // force a status on list (e.g. 401)
    refreshStatus: number | null;
  };
}
export async function startMockGoogle(): Promise<MockGoogle> {
  const state: MockGoogle['state'] = { messages: new Map(), scope: 'https://www.googleapis.com/auth/gmail.readonly', refreshToken: 'rt-SECRET-refresh-token-123', listCalls: [], tokenCalls: [], revoked: [], failList: 0, listStatus: null, refreshStatus: null };
  const server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, v: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(v));
      };
      if (u.pathname === '/token') {
        const f = Object.fromEntries(new URLSearchParams(body));
        state.tokenCalls.push(f);
        if (f.grant_type === 'refresh_token') return state.refreshStatus ? json(state.refreshStatus, { error: 'invalid_grant' }) : json(200, { access_token: 'at-refreshed', expires_in: 3600 });
        return json(200, { access_token: 'at-initial', refresh_token: state.refreshToken, expires_in: 3600, scope: state.scope });
      }
      if (u.pathname === '/revoke') {
        state.revoked.push(Object.fromEntries(new URLSearchParams(body)).token);
        return json(200, {});
      }
      if (u.pathname === '/gmail/users/me/profile') return json(200, { emailAddress: 'Owner@Example.test' });
      if (u.pathname === '/gmail/users/me/messages') {
        state.listCalls.push(u.searchParams.get('q') ?? '');
        if (state.listStatus) return json(state.listStatus, {});
        if (state.failList > 0) {
          state.failList--;
          return json(503, {});
        }
        return json(200, { messages: [...state.messages.keys()].map((id) => ({ id })) });
      }
      const m = /^\/gmail\/users\/me\/messages\/([^/]+)$/.exec(u.pathname);
      if (m && state.messages.has(m[1])) {
        const x = state.messages.get(m[1])!;
        return json(200, { id: m[1], raw: x.raw.toString('base64url'), internalDate: String(x.internalDate) });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as any).port}`, state };
}
export const stopMock = (m: MockGoogle) => {
  m.server.closeAllConnections();
  return new Promise<void>((r) => m.server.close(() => r()));
};
