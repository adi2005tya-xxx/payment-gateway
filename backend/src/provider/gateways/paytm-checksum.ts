import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Paytm's request/response signature ("checksum"): SHA-256 over `payload|salt`, plus the salt, AES-CBC encrypted with the merchant key
 * (fixed IV from Paytm's published algorithm) and base64 encoded.
 */
const IV = Buffer.from('@@@@&&&&####$$$$', 'utf8');

const algo = (key: string) => (key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : key.length === 32 ? 'aes-256-cbc' : null);

function salt(n = 4): string {
  let s = '';
  while (s.length < n) s += randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return s.slice(0, n);
}

/** Parameter map -> canonical string: keys sorted, values joined by "|", null/"null" as empty. */
export function paramString(p: Record<string, unknown>): string {
  return Object.keys(p)
    .sort()
    .map((k) => (p[k] == null || String(p[k]).toLowerCase() === 'null' ? '' : String(p[k])))
    .join('|');
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function generateSignature(input: string | Record<string, unknown>, merchantKey: string, fixedSalt?: string): string {
  const a = algo(merchantKey);
  if (!a) throw new Error('Paytm merchant key must be 16, 24 or 32 characters');
  const s = fixedSalt ?? salt();
  const text = typeof input === 'string' ? input : paramString(input);
  const c = createCipheriv(a, Buffer.from(merchantKey, 'utf8'), IV);
  return Buffer.concat([c.update(sha(`${text}|${s}`) + s, 'utf8'), c.final()]).toString('base64');
}

export function verifySignature(input: string | Record<string, unknown>, merchantKey: string, checksum: string): boolean {
  const a = algo(merchantKey);
  if (!a || !checksum) return false;
  try {
    const d = createDecipheriv(a, Buffer.from(merchantKey, 'utf8'), IV);
    const plain = Buffer.concat([d.update(Buffer.from(checksum, 'base64')), d.final()]).toString('utf8');
    const s = plain.slice(-4);
    const text = typeof input === 'string' ? input : paramString(input);
    return plain === sha(`${text}|${s}`) + s;
  } catch {
    return false;
  }
}
