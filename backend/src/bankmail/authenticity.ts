import { promises as dns } from 'dns';
import { dkimVerify } from 'mailauth';
import { simpleParser } from 'mailparser';
import { TemplateDefinition } from './templates';

export type DnsResolver = (name: string, rr: string) => Promise<any>;
export const systemResolver: DnsResolver = (name, rr) => (dns as any).resolve(name, rr);

export interface ReadMessage {
  from: string | null;
  fromDomain: string | null;
  fromCount: number;
  subject: string;
  text: string;
  messageId: string | null;
  headerDate: Date | null;
}

/** Parses MIME. Only the From header's mailbox, subject and plain text (HTML is converted to text) are used. */
export async function readMessage(raw: Buffer): Promise<ReadMessage> {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const addrs = p.from?.value ?? [];
  const from = addrs.length === 1 && addrs[0].address ? addrs[0].address.trim().toLowerCase() : null;
  const text = (p.text && p.text.trim()) || (typeof p.html === 'string' ? p.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&') : '');
  return {
    from,
    fromDomain: from ? from.split('@')[1] : null,
    fromCount: addrs.length,
    subject: p.subject ?? '',
    text,
    messageId: p.messageId ?? null,
    headerDate: p.date ?? null,
  };
}

export interface AuthResult {
  ok: boolean;
  reason: string;
  signingDomain?: string;
}

/** Raw header block, unfolded, as [name, value] pairs in order. */
function rawHeaders(raw: Buffer): Array<[string, string]> {
  const s = raw.toString('latin1');
  const end = s.search(/\r?\n\r?\n/);
  const block = (end === -1 ? s : s.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  return block.split(/\r?\n/).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as [string, string];
  });
}
const tag = (value: string, name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]*)`, 'i').exec(value)?.[1]?.replace(/\s+/g, '') ?? null;

/**
 * Cryptographic sender authentication. We never trust "Authentication-Results" text in the message (anyone can write that header);
 * the DKIM signature is verified here against the signing domain's public key in DNS. Accepted only if:
 *  - a signature verifies (pass),
 *  - its domain is on the template's allowlist AND is the From domain or a parent of it (alignment),
 *  - it signs the From header,
 *  - it does not use the body-length tag (l=), which would let content be appended after the signed part.
 * What this proves: the bank's domain signed this message. What it does NOT prove: that the money is in your account (that is the
 * bank's statement). It is not bank-level verification.
 */
export async function checkAuthenticity(raw: Buffer, def: TemplateDefinition, fromDomain: string, resolver: DnsResolver = systemResolver): Promise<AuthResult> {
  let results: any[];
  try {
    results = (await dkimVerify(raw, { resolver })).results ?? [];
  } catch (e: any) {
    return { ok: false, reason: `DKIM_VERIFY_ERROR` };
  }
  const passing = results.filter((r) => r.status?.result === 'pass');
  if (!passing.length) {
    const first = results[0]?.status;
    return { ok: false, reason: `DKIM_NOT_PASSING:${first?.result ?? 'none'}${first?.comment ? `(${String(first.comment).slice(0, 60)})` : ''}` };
  }
  const sigs = rawHeaders(raw).filter(([n]) => n === 'dkim-signature').map(([, v]) => v);
  for (const r of passing) {
    const d = String(r.signingDomain ?? '').toLowerCase();
    if (!(def.dkimDomains ?? []).includes(d)) continue;
    if (!(fromDomain === d || fromDomain.endsWith(`.${d}`))) continue;
    const sig = sigs.find((v) => tag(v, 'd')?.toLowerCase() === d && tag(v, 's') === r.selector);
    if (!sig) continue;
    if (tag(sig, 'l') !== null) return { ok: false, reason: 'DKIM_BODY_LENGTH_LIMIT_NOT_ACCEPTED' };
    if (!(tag(sig, 'h') ?? '').toLowerCase().split(':').includes('from')) return { ok: false, reason: 'DKIM_DOES_NOT_SIGN_FROM' };
    return { ok: true, reason: 'DKIM_PASS', signingDomain: d };
  }
  return { ok: false, reason: 'DKIM_DOMAIN_NOT_ALLOWED_OR_NOT_ALIGNED' };
}
