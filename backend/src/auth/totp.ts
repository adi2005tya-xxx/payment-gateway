import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, as recommended by RFC 4226. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_PERIOD = 30;

export function stepAt(timeMs: number, period = TOTP_PERIOD): number {
  return Math.floor(timeMs / 1000 / period);
}

/** RFC 4226 HOTP. */
export function hotp(secret: Buffer, counter: number, digits = 6, alg: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(alg, secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP for the time-step containing `timeMs`. */
export function totpAt(secretB32: string, timeMs: number, digits = 6): string {
  return hotp(base32Decode(secretB32), stepAt(timeMs), digits);
}

/**
 * Returns the matching time-step (within +/- `window` steps) or null.
 * All candidate steps are always evaluated and compared in constant time.
 */
export function matchTotp(secretB32: string, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const current = stepAt(nowMs);
  let matched: number | null = null;
  for (let s = current - window; s <= current + window; s++) {
    if (s < 0) continue;
    const expected = Buffer.from(hotp(key, s));
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null) matched = s;
  }
  return matched;
}

export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}
