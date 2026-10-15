import { randomBytes } from 'crypto';
import { loadConfig } from '../src/common/config';
import { generateRecoveryCode, normaliseRecoveryCode, SecretBox } from '../src/auth/secretbox';
import { base32Decode, base32Encode, generateTotpSecret, hotp, matchTotp, otpauthUri, stepAt, totpAt } from '../src/auth/totp';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1, secret "12345678901234567890", 8 digits.
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches the RFC vector at T=%i', (t, expected) => {
    expect(totpAt(rfcSecret, t * 1000, 8)).toBe(expected);
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    const s = generateTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts only +/-1 step around now and rejects malformed codes', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const at = (delta: number) => hotp(base32Decode(secret), stepAt(now) + delta);
    expect(matchTotp(secret, at(0), now)).toBe(stepAt(now));
    expect(matchTotp(secret, at(-1), now)).toBe(stepAt(now) - 1);
    expect(matchTotp(secret, at(1), now)).toBe(stepAt(now) + 1);
    expect(matchTotp(secret, at(2), now)).toBeNull();
    expect(matchTotp(secret, at(-2), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) expect(matchTotp(secret, bad, now)).toBeNull();
  });

  it('builds a standard otpauth URI', () => {
    const uri = otpauthUri('Gateway', 'a@b.test', 'JBSWY3DPEHPK3PXP');
    expect(uri).toBe('otpauth://totp/Gateway%3Aa%40b.test?secret=JBSWY3DPEHPK3PXP&issuer=Gateway&algorithm=SHA1&digits=6&period=30');
  });
});

describe('SecretBox', () => {
  const key = randomBytes(32);
  it('encrypts without exposing plaintext and decrypts with the right user binding', () => {
    const box = new SecretBox(key);
    const env = box.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    expect(env.startsWith('v1.')).toBe(true);
    expect(env).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.encrypt('JBSWY3DPEHPK3PXP', 'user-1')).not.toBe(env); // random IV
    expect(box.decrypt(env, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects ciphertext moved to another user, tampered ciphertext, and wrong keys', () => {
    const box = new SecretBox(key);
    const env = box.encrypt('SECRET', 'user-1');
    expect(() => box.decrypt(env, 'user-2')).toThrow();
    const parts = env.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'user-1')).toThrow();
    expect(() => new SecretBox(randomBytes(32)).decrypt(env, 'user-1')).toThrow();
  });

  it('supports key rotation via previous keys', () => {
    const oldKey = randomBytes(32);
    const env = new SecretBox(oldKey).encrypt('SECRET', 'u');
    const rotated = new SecretBox(randomBytes(32), [oldKey]);
    expect(rotated.decrypt(env, 'u')).toBe('SECRET');
    expect(rotated.encrypt('X', 'u')).not.toBe(env);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow();
  });

  it('hashes recovery codes with a keyed, normalised hash', () => {
    const box = new SecretBox(key);
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(box.hashRecoveryCode(code)).toBe(box.hashRecoveryCode(code.toLowerCase().replace('-', ' ')));
    expect(box.hashRecoveryCode(code)).not.toContain(normaliseRecoveryCode(code));
    expect(new SecretBox(randomBytes(32)).hashRecoveryCode(code)).not.toBe(box.hashRecoveryCode(code)); // keyed
    expect(new Set(Array.from({ length: 200 }, generateRecoveryCode)).size).toBe(200);
  });
});

describe('configuration validation', () => {
  const base = {
    JWT_SECRET: 'j'.repeat(40),
    PROVIDER_WEBHOOK_SECRET: 'w'.repeat(20),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  it('accepts a valid configuration with safe defaults', () => {
    const c = loadConfig({ ...base });
    expect(c).toMatchObject({ MFA_REQUIRED_ROLES: 'ADMIN', MFA_STEPUP_WINDOW_SECONDS: 300, MFA_RECOVERY_DELAY_HOURS: 24 });
  });
  it.each([
    ['missing MFA key', { MFA_ENCRYPTION_KEY: undefined }],
    ['short MFA key', { MFA_ENCRYPTION_KEY: randomBytes(16).toString('base64') }],
    ['non-base64 MFA key', { MFA_ENCRYPTION_KEY: '!!!not-base64!!!' }],
    ['bad previous key', { MFA_ENCRYPTION_KEY_PREVIOUS: 'abc' }],
    ['ADMIN removed from required roles', { MFA_REQUIRED_ROLES: 'MERCHANT' }],
    ['step-up window too long', { MFA_STEPUP_WINDOW_SECONDS: '3600' }],
    ['step-up window too short', { MFA_STEPUP_WINDOW_SECONDS: '5' }],
    ['zero recovery delay in production', { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', MFA_RECOVERY_DELAY_HOURS: '0' }],
  ])('rejects: %s', (_name, override) => {
    expect(() => loadConfig({ ...base, ...(override as any) })).toThrow();
  });
});
