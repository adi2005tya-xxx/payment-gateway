import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'crypto';

const b64 = (b: Buffer) => b.toString('base64url');
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/**
 * AES-256-GCM envelope encryption for MFA secrets.
 * - Ciphertext is bound (AAD) to the owning user id, so rows cannot be swapped between users.
 * - `previous` keys allow rotation: new writes use `current`, old rows still decrypt.
 * The key itself is injected (from a secrets manager in production); it never lives in the database.
 */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();
  private readonly current: Buffer;
  private readonly recoveryKey: Buffer;

  constructor(current: Buffer, previous: Buffer[] = []) {
    if (current.length !== 32) throw new Error('MFA encryption key must be 32 bytes');
    this.current = current;
    for (const k of [current, ...previous]) {
      if (k.length !== 32) throw new Error('MFA encryption key must be 32 bytes');
      this.keys.set(keyId(k), k);
    }
    // Separate, derived key for hashing recovery codes (domain separation from the encryption key).
    this.recoveryKey = Buffer.from(hkdfSync('sha256', current, Buffer.alloc(0), 'gateway-mfa-recovery-code-v1', 32));
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.current, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return ['v1', keyId(this.current), b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
  }

  decrypt(envelope: string, aad: string): string {
    const [v, kid, iv, tag, ct] = envelope.split('.');
    const key = this.keys.get(kid);
    if (v !== 'v1' || !key || !iv || !tag || !ct) throw new Error('cannot decrypt MFA secret');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /** Keyed hash of a normalised recovery code. Codes are high-entropy random, so a fast keyed hash is appropriate. */
  hashRecoveryCode(code: string): string {
    return createHmac('sha256', this.recoveryKey).update(normaliseRecoveryCode(code)).digest('hex');
  }
}

const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** 10 random characters (~50 bits) formatted XXXXX-XXXXX. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let s = '';
  for (const b of bytes) s += RC_ALPHABET[b % RC_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
