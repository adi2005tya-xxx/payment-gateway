import { z } from 'zod';
import type { SecurityOptions } from '../auth/auth.service';

function isKey32(v: string): boolean {
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** sandbox: simulated provider, simulated money. live: requires an approved real provider adapter. */
  PAYMENT_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PROVIDER_WEBHOOK_SECRET: z.string().min(16),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3001'),
  /** sandbox: card/UPI-gateway style simulator. owner-account-sandbox: simulated owner bank account (customers pay the owner's UPI ID, payouts to merchants' UPI IDs). */
  PROVIDER_KIND: z.enum(['sandbox', 'owner-account-sandbox', 'bank-email', 'razorpay', 'phonepe', 'paytm']).default('sandbox'),
  /** razorpay / phonepe / paytm: real provider APIs in TEST mode only (see docs/payment-gateways.md). */
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  PHONEPE_MERCHANT_ID: z.string().default(''),
  PHONEPE_SALT_KEY: z.string().default(''),
  PHONEPE_SALT_INDEX: z.string().default('1'),
  PHONEPE_BASE_URL: z.string().default('https://api-preprod.phonepe.com/apis/pg-sandbox'),
  PAYTM_MID: z.string().default(''),
  PAYTM_MERCHANT_KEY: z.string().default(''),
  PAYTM_WEBSITE: z.string().default('WEBSTAGING'),
  PAYTM_BASE_URL: z.string().default('https://securestage.paytmpayments.com'),
  /** Public UPI ID customers pay (appears in QR codes). Not a secret. */
  OWNER_UPI_ID: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$/, 'OWNER_UPI_ID must look like name@bank').default('gateway-sandbox@sandboxbank'),
  /** bank-email mode: Google OAuth client (create it in Google Cloud Console; scope gmail.readonly only). */
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),
  /** Sandbox/dev: read bank alert .eml files from this folder instead of Gmail. Same authenticity checks apply. */
  MAIL_FOLDER_DIR: z.string().default(''),
  MAIL_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  /** reference_required (default): the alert must carry the order id. unique_amount_window: also accept exactly one pending order with that exact amount whose time window contains the credit (weaker; read docs/bank-email.md). */
  MATCH_POLICY: z.enum(['reference_required', 'unique_amount_window']).default('reference_required'),
  ALERT_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  /** Phone notification/SMS evidence (unverified): never auto-confirm a credit above this (paise); default INR 500. */
  DEVICE_AUTO_CONFIRM_MAX_MINOR: z.coerce.number().int().min(100).default(50_000),
  /** ...and at most this much in any rolling 24 hours (paise); default INR 5,000. */
  DEVICE_DAILY_AUTO_LIMIT_MINOR: z.coerce.number().int().min(100).default(500_000),
  DEVICE_MAX_AGE_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  ORDER_DEFAULT_EXPIRY_MINUTES: z.coerce.number().int().min(5).max(10080).default(60),
  /** An unpaid order stays PENDING this long after expiry so a delayed bank alert can still confirm it. */
  ORDER_GRACE_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
  OWNER_OPENING_BALANCE_MINOR: z.coerce.number().int().min(0).default(0),
  UPI_PAYOUT_LIMIT_MINOR: z.coerce.number().int().min(100).default(10_000_000),
  /** base64 of exactly 32 random bytes. Inject from a secrets manager; rotate by moving the old value to _PREVIOUS. */
  MFA_ENCRYPTION_KEY: z.string().refine(isKey32, 'MFA_ENCRYPTION_KEY must be base64 of exactly 32 bytes'),
  MFA_ENCRYPTION_KEY_PREVIOUS: z.string().refine((v) => v === '' || isKey32(v), 'MFA_ENCRYPTION_KEY_PREVIOUS must be base64 of exactly 32 bytes').default(''),
  MFA_ISSUER: z.string().min(1).max(60).default('Gateway'),
  MFA_REQUIRED_ROLES: z.string().default('ADMIN'),
  MFA_STEPUP_WINDOW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  MFA_RECOVERY_DELAY_HOURS: z.coerce.number().min(0).max(168).default(24),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(720).default(60),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** Browser origin allowed to call the API (CORS). Empty = no cross-origin access. */
  WEB_ORIGIN: z.string().default(''),
  /** e.g. smtps://user:pass@smtp.example.com:465 . Empty = notifications are only logged (kind + masked recipient). */
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Gateway <no-reply@localhost>'),
  /** Slack-compatible incoming webhook (or any JSON endpoint) for critical/warning alerts. */
  ALERT_WEBHOOK_URL: z.string().default(''),
  ALERT_WEBHOOK_SECRET: z.string().default(''),
  /** Enables the no-login Rs 1 "try a test payment" button (test mode only). Off by default. */
  DEMO_PAYMENTS_ENABLED: z.enum(['true', 'false']).default('false'),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_MFA_PER_MIN: z.coerce.number().int().min(1).default(10),
});
export type AppConfig = z.infer<typeof schema>;
export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cfg = schema.parse(env);
  if (cfg.PAYMENT_MODE === 'live') {
    throw new Error(
      'PAYMENT_MODE=live is blocked: no approved production provider adapter is installed. ' +
        'See docs/provider-integration-checklist.md and docs/regulatory-checklist.md.',
    );
  }
  const need: Record<string, string[]> = {
    razorpay: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
    phonepe: ['PHONEPE_MERCHANT_ID', 'PHONEPE_SALT_KEY'],
    paytm: ['PAYTM_MID', 'PAYTM_MERCHANT_KEY'],
  };
  const missing = (need[cfg.PROVIDER_KIND] ?? []).filter((k) => !(cfg as Record<string, unknown>)[k]);
  if (missing.length) throw new Error(`PROVIDER_KIND=${cfg.PROVIDER_KIND} requires: ${missing.join(', ')}`);
  if (cfg.PROVIDER_KIND === 'bank-email' && !cfg.GOOGLE_CLIENT_ID !== !cfg.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
  if (cfg.GOOGLE_CLIENT_ID && !/^https?:\/\//.test(cfg.GOOGLE_REDIRECT_URI)) throw new Error('GOOGLE_REDIRECT_URI must be an http(s) URL');
  if (!cfg.MFA_REQUIRED_ROLES.split(',').map((r) => r.trim()).includes('ADMIN')) throw new Error('MFA_REQUIRED_ROLES must include ADMIN');
  if (cfg.NODE_ENV === 'production' && cfg.MFA_RECOVERY_DELAY_HOURS < 1) throw new Error('MFA_RECOVERY_DELAY_HOURS must be >= 1 in production');
  if (cfg.NODE_ENV === 'production' && !cfg.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  return cfg;
}

export function securityOptions(cfg: AppConfig): SecurityOptions {
  return {
    mfaKey: Buffer.from(cfg.MFA_ENCRYPTION_KEY, 'base64'),
    mfaKeyPrevious: cfg.MFA_ENCRYPTION_KEY_PREVIOUS ? [Buffer.from(cfg.MFA_ENCRYPTION_KEY_PREVIOUS, 'base64')] : [],
    issuer: cfg.MFA_ISSUER,
    stepUpWindowSeconds: cfg.MFA_STEPUP_WINDOW_SECONDS,
    recoveryDelayHours: cfg.MFA_RECOVERY_DELAY_HOURS,
    requiredRoles: cfg.MFA_REQUIRED_ROLES.split(',').map((r) => r.trim()).filter(Boolean),
    sessionTtlMinutes: cfg.SESSION_TTL_MINUTES,
    maxMfaAttempts: 5,
    mfaLockMinutes: 15,
    maxLoginAttempts: 5,
    loginLockMinutes: 15,
  };
}
