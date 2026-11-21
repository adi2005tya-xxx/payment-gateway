/** Dev helper: seeds a verified test merchant and one Rs 10 payment request against the configured provider, prints the checkout link. Run BEFORE starting the server (embedded DB is single-process). */
import { mkdirSync } from 'fs';
import { hashPassword } from '../src/auth/auth';
import { loadConfig, securityOptions } from '../src/common/config';
import { migrate } from '../src/db/db';
import { PgliteDb } from '../src/db/pglite.db';
import { createPlatform } from '../src/platform';
import { RazorpayProvider } from '../src/provider/gateways/razorpay.provider';

(async () => {
  const cfg = loadConfig();
  if (cfg.PROVIDER_KIND !== 'razorpay') throw new Error('set PROVIDER_KIND=razorpay');
  mkdirSync(cfg.PGLITE_DIR, { recursive: true });
  const db = await PgliteDb.open(cfg.PGLITE_DIR);
  await migrate(db);
  const provider = new RazorpayProvider({ keyId: cfg.RAZORPAY_KEY_ID, keySecret: cfg.RAZORPAY_KEY_SECRET, webhookSecret: cfg.RAZORPAY_WEBHOOK_SECRET, publicBaseUrl: cfg.PUBLIC_BASE_URL });
  const p = createPlatform(db, provider, securityOptions(cfg));
  const email = 'demo-merchant@example.test';
  const [admin] = await db.query<{ id: string }>(`INSERT INTO users(email, password_hash, role) VALUES ('seed-admin@example.test','x','ADMIN') ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`);
  const reg = await p.merchants.register({ email, passwordHash: await hashPassword('Demo-Merchant-Pass-123!'), legalName: 'Demo Traders Pvt Ltd', displayName: 'Demo Traders' });
  const adminActor = { id: admin.id, role: 'ADMIN' as const };
  await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', adminActor);
  const actor = { id: reg.userId, role: 'MERCHANT' as const, merchantId: reg.merchantId };
  const dest = await p.merchants.addDestination(reg.merchantId, { label: 'Primary', providerDestinationRef: 'fa_demo_0001', maskedAccount: 'XXXX1234' }, actor);
  await p.merchants.verifyDestination(dest, adminActor);
  const req = await p.requests.create(reg.merchantId, { orderReference: 'DEMO-' + Date.now(), amountMinor: 1000, description: 'Razorpay test payment' }, actor);
  console.log('CHECKOUT_URL=' + req.checkoutUrl);
  await db.close();
})().catch((e) => { console.error('SEED FAILED:', e?.message ?? e); process.exit(1); });
