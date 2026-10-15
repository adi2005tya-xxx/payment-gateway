// Drives the real UI against the real API (sandbox) in headless Chromium.
//   1) start the API:  PROVIDER_KIND=owner-account-sandbox WEB_ORIGIN=http://localhost:3010 MFA_STEPUP_WINDOW_SECONDS=30 ... (see docs/web.md)
//   2) start the web:  npm run build && npm run start
//   3) node e2e/full-flow.mjs
import { chromium } from 'playwright';
import { createHmac } from 'crypto';
import { mkdirSync } from 'fs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3010';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password-1';
const OUT = 'e2e-output';
mkdirSync(OUT, { recursive: true });

// ---- TOTP (RFC 6238) so the script can act as the admin's authenticator app
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s) => { let bits = 0, v = 0; const o = []; for (const c of s.replace(/[\s=]/g, '').toUpperCase()) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const hotp = (key, ctr) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(ctr)); const h = createHmac('sha1', key).update(m).digest(); const o = h[19] & 15; return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0'); };
let lastStep = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freshCode(secret) {
  let step = Math.floor(Date.now() / 30000);
  while (step <= lastStep) { await sleep(1000); step = Math.floor(Date.now() / 30000); } // a code can be used once
  lastStep = step;
  return hotp(b32(secret), step);
}

const results = [];
let adminSecret = '';
const consoleErrors = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log('PASS', name, `(${Date.now() - t} ms)`); }
  catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, err: String(e.message).split('\n')[0] });
    console.log('FAIL', name, '::', String(e.message).split('\n')[0]);
    for (const [who, pg] of [['admin', admin], ['merchant', merchant]]) {
      try {
        await pg.screenshot({ path: `${OUT}/fail-${results.length}-${who}.png`, fullPage: true });
        console.log('   ', who, 'url:', pg.url(), '| text:', (await pg.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500));
      } catch { /* page gone */ }
    }
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => consoleErrors.push(`${who} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(`${who} console: ${m.text()}`); });
};
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const merchant = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
watch(admin, 'admin'); watch(merchant, 'merchant');
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

/** If a high-risk action asked for a fresh authenticator code, supply one. */
async function maybeStepUp(page) {
  const dlg = page.getByRole('dialog', { name: "Confirm it's you" });
  try { await dlg.waitFor({ timeout: 2500 }); } catch { return false; }
  await dlg.getByLabel('Authenticator code').fill(await freshCode(adminSecret));
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 10000 });
  return true;
}

const BIZ = 'Acme Traders Pvt Ltd';
const MERCHANT_EMAIL = `acme-${Date.now()}@example.test`;
let payLink = '';

await step('admin: first sign-in forces two-step enrolment (QR, manual key, confirm code, recovery codes)', async () => {
  await admin.goto(`${WEB}/login`);
  await admin.getByLabel('Email').fill(ADMIN_EMAIL);
  await admin.getByLabel('Password').fill(ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
  expect(await admin.getByAltText('QR code for your authenticator app').isVisible(), 'QR not shown');
  await shot(admin, '01-admin-enrol');
  await admin.getByText("Can't scan? Enter the key manually").click();
  adminSecret = (await admin.locator('details code').innerText()).trim();
  expect(/^[A-Z2-7]{32}$/.test(adminSecret), 'secret not shown');
  await admin.getByLabel('Enter the 6-digit code from the app').fill(await freshCode(adminSecret));
  await admin.getByRole('button', { name: 'Verify and continue' }).click();
  await admin.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
  expect((await admin.locator('ul li').count()) === 10, 'expected 10 recovery codes');
  const cont = admin.getByRole('button', { name: 'Continue' });
  expect(await cont.isDisabled(), 'Continue must stay disabled until the codes are acknowledged');
  await admin.getByLabel('I have saved these codes somewhere safe.').check();
  await cont.click();
  await admin.waitForURL('**/admin');
  await admin.getByRole('heading', { name: 'Overview' }).waitFor();
  await shot(admin, '02-admin-overview');
});

await step('merchant: registers, signs in, sees the pending-verification notice', async () => {
  await merchant.goto(`${WEB}/register`);
  await merchant.getByLabel('Registered business name').fill(BIZ);
  await merchant.getByLabel('Display name').fill('Acme Traders');
  await merchant.getByLabel('Email').fill(MERCHANT_EMAIL);
  await merchant.getByLabel('Password').fill('merchant-password-123');
  await merchant.getByRole('button', { name: 'Create account' }).click();
  await merchant.getByRole('heading', { name: 'Application received' }).waitFor();
  await merchant.goto(`${WEB}/login`);
  await merchant.getByLabel('Email').fill(MERCHANT_EMAIL);
  await merchant.getByLabel('Password').fill('merchant-password-123');
  await merchant.getByRole('button', { name: 'Sign in' }).click();
  await merchant.waitForURL('**/merchant');
  await merchant.getByText('awaiting verification').waitFor();
  await shot(merchant, '03-merchant-pending');
});

await step('admin: approves the merchant (step-up code is requested if the window lapsed)', async () => {
  await admin.goto(`${WEB}/admin/merchants`);
  const row = admin.getByRole('row', { name: new RegExp(BIZ) }).first();
  await row.getByRole('button', { name: 'Approve' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await maybeStepUp(admin);
  await admin.getByRole('dialog', { name: new RegExp(`Approve ${BIZ}`) }).waitFor({ state: 'detached', timeout: 10000 });
  await admin.getByRole('row', { name: new RegExp(BIZ) }).getByText('ACTIVE').first().waitFor();
  await shot(admin, '04-admin-merchants');
});

await step('merchant: adds a UPI ID; only the masked form is shown', async () => {
  await merchant.goto(`${WEB}/merchant/account`);
  await merchant.getByLabel('Add your UPI ID').fill('acme.shop@okhdfc');
  await merchant.getByRole('button', { name: 'Validate and add' }).click();
  await merchant.getByText('An administrator must verify it').waitFor();
  const body = await merchant.locator('body').innerText();
  expect(body.includes('ac****@okhdfc'), 'masked UPI id not shown');
  expect(!body.includes('acme.shop@okhdfc'), 'raw UPI id leaked into the page');
  await shot(merchant, '05-merchant-account');
});

await step('admin: sees the name MISMATCH on the destination, must confirm explicitly, verifies it (after the step-up window lapses)', async () => {
  await sleep(32000); // MFA_STEPUP_WINDOW_SECONDS=30 in this run, so a fresh code is demanded
  await admin.goto(`${WEB}/admin/destinations`);
  const row = admin.getByRole('row', { name: /ac\*\*\*\*@okhdfc/ });
  await row.getByText('MISMATCH').waitFor();
  await shot(admin, '06-admin-destinations');
  let confirmText = '';
  admin.once('dialog', async (d) => { confirmText = d.message(); await d.accept(); });
  await row.getByRole('button', { name: 'Verify' }).click();
  const asked = await maybeStepUp(admin);
  expect(asked, 'the step-up modal should have appeared after the window lapsed');
  expect(/does not match/.test(confirmText), 'no mismatch confirmation was shown to the admin');
  await admin.getByText('No destinations in this state.').waitFor({ timeout: 10000 });
});

await step('merchant: creates a payment request and gets a link and QR', async () => {
  await merchant.goto(`${WEB}/merchant/requests`);
  await merchant.getByLabel('Order / invoice reference').fill('INV-1001');
  await merchant.getByLabel('Amount (₹)').fill('1250');
  await merchant.getByLabel('Description').fill('Consulting');
  await merchant.getByRole('button', { name: 'Create payment link' }).click();
  const dlg = merchant.getByRole('dialog', { name: 'Share this payment link' });
  await dlg.waitFor();
  await dlg.getByAltText('Payment QR code').waitFor();
  payLink = await dlg.getByLabel('Payment link').inputValue();
  expect(/\/pay\/[A-Za-z0-9_-]{20,}$/.test(payLink), 'bad link ' + payLink);
  await shot(merchant, '07-merchant-link');
  await dlg.getByRole('button', { name: 'Done' }).click();
});

await step('customer: sees merchant/amount/QR, a UPI deep link with the unique reference, and the page confirms only after verification', async () => {
  const customer = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  watch(customer, 'customer');
  await customer.goto(payLink);
  await customer.getByText('Acme Traders').first().waitFor();
  expect(await customer.getByText('₹1,250.00').isVisible(), 'amount not shown');
  expect(await customer.getByText('Consulting').isVisible(), 'description not shown');
  const href = await customer.getByRole('link', { name: 'Pay with your UPI app' }).getAttribute('href');
  expect(/^upi:\/\/pay\?pa=gateway-sandbox%40sandboxbank&.*am=1250\.00.*tr=GW[A-Z2-9]{10}/.test(href), 'bad UPI link: ' + href);
  expect(!(await customer.getByText('Payment confirmed').isVisible()), 'must not show paid before payment');
  await shot(customer, '08-customer-awaiting');
  await customer.getByRole('button', { name: 'Simulate payment' }).click();
  await customer.getByText('Payment confirmed').waitFor({ timeout: 30000 });
  await shot(customer, '09-customer-paid');
  const text = await customer.locator('body').innerText();
  expect(!/merchant_id|public_token|provider/i.test(text), 'internal fields leaked on the customer page');
});

await step('merchant: balances show the verified payment, fee and payable; payments list shows it', async () => {
  await merchant.goto(`${WEB}/merchant`);
  await merchant.getByText('₹1,225.00').first().waitFor({ timeout: 15000 }); // 1,250 less 2% fee
  await shot(merchant, '10-merchant-overview');
  await merchant.goto(`${WEB}/merchant/payments`);
  const row = merchant.getByRole('row', { name: /INV-1001/ });
  await row.getByText('SUCCEEDED').waitFor();
  await shot(merchant, '11-merchant-payments');
});

await step('merchant: requests a payout to the verified UPI ID and it settles', async () => {
  await merchant.goto(`${WEB}/merchant/settlements`);
  await merchant.getByText('To ac****@okhdfc').waitFor();
  await merchant.getByRole('button', { name: 'Request payout' }).click();
  await merchant.getByText('Payout requested').waitFor();
  const deadline = Date.now() + 40000;
  let ok = false;
  while (Date.now() < deadline && !ok) {
    await merchant.reload();
    ok = await merchant.getByRole('row').filter({ hasText: '₹1,225.00' }).getByText('SUCCEEDED').first().waitFor({ timeout: 4000 }).then(() => true, () => false);
    if (!ok) await sleep(2000);
  }
  expect(ok, 'payout did not reach SUCCEEDED');
  await shot(merchant, '12-merchant-settlements');
});

await step('admin: dashboards reflect the activity; audit log shows the trail; alerts page loads', async () => {
  await admin.goto(`${WEB}/admin`);
  await admin.getByText('Verified payments today').waitFor();
  await admin.getByText('Ledger balanced').waitFor();
  expect(await admin.getByText('Ledger balanced').locator('xpath=following-sibling::dd[1]').innerText() === 'YES', 'ledger not reported balanced');
  await shot(admin, '13-admin-overview-after');
  await admin.goto(`${WEB}/admin/audit`);
  for (const a of ['payout.requested', 'destination.verified', 'payment.verified', 'mfa.enrolled']) await admin.getByText(a, { exact: true }).first().waitFor();
  await shot(admin, '14-admin-audit');
  await admin.goto(`${WEB}/admin/payouts`);
  await admin.getByRole('row').getByText('SUCCEEDED').first().waitFor();
  await admin.goto(`${WEB}/admin/recovery`);
  await admin.getByText('Outbound money is flowing normally.').waitFor();
  await shot(admin, '15-admin-recovery');
});

await step('boundaries: a merchant cannot open admin pages; signed-out visitors go to login; sign-out kills the session', async () => {
  await merchant.goto(`${WEB}/admin`);
  await merchant.waitForURL('**/merchant');
  await merchant.getByRole('button', { name: 'Sign out' }).click();
  await merchant.waitForURL('**/login');
  await merchant.goto(`${WEB}/merchant/payments`);
  await merchant.waitForURL('**/login');
});

await step('no browser console errors or uncaught exceptions during the whole run', async () => {
  expect(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI steps passed`);
process.exit(failed.length ? 1 : 0);
