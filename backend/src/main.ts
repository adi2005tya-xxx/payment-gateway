import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { createApp } from './app';
import { hashPassword } from './auth/auth';
import { loadConfig, securityOptions } from './common/config';
import { Db, migrate } from './db/db';
import { PgDb } from './db/pg.db';
import { PgliteDb } from './db/pglite.db';
import { createPlatform } from './platform';
import { ConsoleNotifier, SmtpNotifier } from './ops/notifications';
import { WebhookAlertSink } from './ops/alerts';
import { SandboxProvider } from './provider/sandbox.provider';
import { SandboxBankAccountProvider } from './provider/sandbox-bank.provider';
import { BankEmailProvider } from './provider/bank-email.provider';
import { GOOGLE_DEFAULTS } from './bankmail/gmail';
import { PaymentProvider } from './provider/provider';
import { RazorpayProvider } from './provider/gateways/razorpay.provider';
import { PhonePeProvider } from './provider/gateways/phonepe.provider';
import { PaytmProvider } from './provider/gateways/paytm.provider';

async function main() {
  const cfg = loadConfig();
  let db: Db;
  if (cfg.DATABASE_URL) db = new PgDb(cfg.DATABASE_URL);
  else {
    mkdirSync(cfg.PGLITE_DIR, { recursive: true });
    db = await PgliteDb.open(cfg.PGLITE_DIR);
  }
  console.log('migrations applied:', await migrate(db));

  // razorpay/phonepe/paytm talk to the real provider APIs in TEST mode only (docs/payment-gateways.md). PAYMENT_MODE=live stays blocked.
  const resolveMerchantRef = async (orderId: string) =>
    (await db.query<{ merchant_id: string }>('SELECT merchant_id FROM payment_requests WHERE provider_order_id=$1', [orderId]))[0]?.merchant_id ?? null;
  const provider: PaymentProvider =
    cfg.PROVIDER_KIND === 'razorpay'
      ? new RazorpayProvider({ keyId: cfg.RAZORPAY_KEY_ID, keySecret: cfg.RAZORPAY_KEY_SECRET, webhookSecret: cfg.RAZORPAY_WEBHOOK_SECRET, publicBaseUrl: cfg.PUBLIC_BASE_URL })
      : cfg.PROVIDER_KIND === 'phonepe'
      ? new PhonePeProvider({ merchantId: cfg.PHONEPE_MERCHANT_ID, saltKey: cfg.PHONEPE_SALT_KEY, saltIndex: cfg.PHONEPE_SALT_INDEX, baseUrl: cfg.PHONEPE_BASE_URL, publicBaseUrl: cfg.PUBLIC_BASE_URL, resolveMerchantRef })
      : cfg.PROVIDER_KIND === 'paytm'
      ? new PaytmProvider({ mid: cfg.PAYTM_MID, merchantKey: cfg.PAYTM_MERCHANT_KEY, website: cfg.PAYTM_WEBSITE, baseUrl: cfg.PAYTM_BASE_URL, publicBaseUrl: cfg.PUBLIC_BASE_URL, resolveMerchantRef })
      : cfg.PROVIDER_KIND === 'bank-email'
      ? new BankEmailProvider(db, cfg.PUBLIC_BASE_URL, cfg.ORDER_DEFAULT_EXPIRY_MINUTES, cfg.ORDER_GRACE_MINUTES)
      : cfg.PROVIDER_KIND === 'owner-account-sandbox'
      ? new SandboxBankAccountProvider(cfg.PROVIDER_WEBHOOK_SECRET, cfg.PUBLIC_BASE_URL, cfg.OWNER_UPI_ID, { openingBalanceMinor: cfg.OWNER_OPENING_BALANCE_MINOR, upiPayoutLimitMinor: cfg.UPI_PAYOUT_LIMIT_MINOR })
      : new SandboxProvider(cfg.PROVIDER_WEBHOOK_SECRET, cfg.PUBLIC_BASE_URL);
  const platform = createPlatform(db, provider, securityOptions(cfg), {
    notifier: cfg.SMTP_URL ? new SmtpNotifier(cfg.SMTP_URL, cfg.MAIL_FROM) : new ConsoleNotifier(),
    alertSink: cfg.ALERT_WEBHOOK_URL ? new WebhookAlertSink(cfg.ALERT_WEBHOOK_URL, cfg.ALERT_WEBHOOK_SECRET || undefined) : undefined,
    webBaseUrl: cfg.WEB_BASE_URL,
    bankmail: {
      ingest: { matchPolicy: cfg.MATCH_POLICY, maxAlertAgeHours: cfg.ALERT_MAX_AGE_HOURS, deviceAutoConfirmMaxMinor: cfg.DEVICE_AUTO_CONFIRM_MAX_MINOR, deviceDailyLimitMinor: cfg.DEVICE_DAILY_AUTO_LIMIT_MINOR, deviceMaxAgeMinutes: cfg.DEVICE_MAX_AGE_MINUTES },
      google: cfg.GOOGLE_CLIENT_ID ? { clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, redirectUri: cfg.GOOGLE_REDIRECT_URI, ...GOOGLE_DEFAULTS } : undefined,
      mailbox: { syncIntervalSeconds: cfg.MAIL_SYNC_INTERVAL_SECONDS, folderDir: cfg.MAIL_FOLDER_DIR || undefined },
    },
  });
  const startup = await platform.recovery.startupCheck();
  if (startup.frozen) console.warn('MONEY-OUT IS FROZEN (restore/failover detected or manual). Run reconciliation and release via /admin/recovery/unfreeze.');

  if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    const e = process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    await db.query(`INSERT INTO users(email, password_hash, role) VALUES ($1,$2,'ADMIN') ON CONFLICT (email) DO NOTHING`, [e, await hashPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD)]);
  }

  const app = await createApp({ platform, jwtSecret: cfg.JWT_SECRET, rateLimits: { auth: cfg.RATE_LIMIT_AUTH_PER_MIN, mfa: cfg.RATE_LIMIT_MFA_PER_MIN }, corsOrigin: cfg.WEB_ORIGIN || undefined, demoPayments: cfg.DEMO_PAYMENTS_ENABLED === 'true' });
  await app.listen(cfg.PORT);
  console.log(`Gateway API on :${cfg.PORT} [${cfg.PAYMENT_MODE.toUpperCase()} - SIMULATED MONEY ONLY]`);

  if (process.env.WORKER_ENABLED !== 'false') {
    let busy = false;
    let lastOps = 0;
    let lastMonitor = 0;
    let lastAudit = 0;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await platform.jobs.drain(platform.handlers);
        await platform.requests.expireStale();
        const t = Date.now();
        if (t - lastOps >= 30_000) {
          lastOps = t;
          await platform.notifications.dispatchDue();
          if (cfg.PROVIDER_KIND === 'bank-email') await platform.mailbox.syncIfDue().catch((e) => console.warn('mailbox sync failed:', e instanceof Error ? e.message : e));
          await platform.alerts.routeDue();
        }
        if (t - lastMonitor >= 5 * 60_000) {
          lastMonitor = t;
          await platform.monitor.runChecks({ fullAudit: t - lastAudit >= 3600_000 && !!(lastAudit = t) });
        }
      } catch (e) {
        console.error('worker tick failed', e instanceof Error ? e.message : e);
      } finally {
        busy = false;
      }
    }, 1000);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
