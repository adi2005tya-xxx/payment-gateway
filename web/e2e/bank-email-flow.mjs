// Drives the UPI collections + bank mailbox pages in headless Chromium against the real API (PROVIDER_KIND=bank-email).
// Start the API with: $env:E2E_PROVIDER_KIND='bank-email'; e2e\start-api.ps1   and the web app on :3010, then: node e2e/bank-email-flow.mjs
// The email used here is SYNTHETIC and unsigned: the point is that the pipeline REJECTS it. (A genuine signed email needs your bank's DNS key.)
import { chromium } from 'playwright';
import { createHmac } from 'crypto';
import { mkdirSync } from 'fs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3010';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'e2e-admin-password-1';
const OUT = 'e2e-output';
mkdirSync(OUT, { recursive: true });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s) => { let bits = 0, v = 0; const o = []; for (const c of s.replace(/[\s=]/g, '').toUpperCase()) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const hotp = (key, ctr) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(ctr)); const h = createHmac('sha1', key).update(m).digest(); const o = h[19] & 15; return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0'); };
let lastStep = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freshCode(secret) { let step = Math.floor(Date.now() / 30000); while (step <= lastStep) { await sleep(1000); step = Math.floor(Date.now() / 30000); } lastStep = step; return hotp(b32(secret), step); }

const results = [];
let secret = '';
const consoleErrors = [];
const expect = (c, m) => { if (!c) throw new Error(m); };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(`console: ${m.text()}`); });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name, `(${Date.now() - t} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log('FAIL', name, '::', String(e.message).split('\n')[0]); try { await shot(`fail-${results.length}`); console.log('    text:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500)); } catch { /* ignore */ } }
}
async function maybeStepUp() {
  const dlg = page.getByRole('dialog', { name: "Confirm it's you" });
  try { await dlg.waitFor({ timeout: 2500 }); } catch { return false; }
  await dlg.getByLabel('Authenticator code').fill(await freshCode(secret));
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 10000 });
  return true;
}

await step('admin enrols two-step verification', async () => {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
  await page.getByText("Can't scan? Enter the key manually").click();
  secret = (await page.locator('details code').innerText()).trim();
  await page.getByLabel('Enter the 6-digit code from the app').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByLabel('I have saved these codes somewhere safe.').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/admin');
});

await step('collections: warns that no mailbox is connected, then creates a UPI QR with a unique order id', async () => {
  await page.goto(`${WEB}/admin/collections`);
  await page.getByText('No bank mailbox is connected').waitFor();
  await page.getByLabel('Your UPI ID (who receives the money)').fill('owner.shop@okhdfc');
  await page.getByLabel('Amount (₹)').fill('1250');
  await page.getByLabel('Description').fill('Consulting');
  await page.getByRole('button', { name: 'Generate UPI QR' }).click();
  const dlg = page.getByRole('dialog', { name: 'Scan to pay' });
  await dlg.waitFor();
  expect(await dlg.getByAltText(/UPI QR for owner.shop@okhdfc/).isVisible(), 'QR not shown');
  const id = (await dlg.locator('code').first().innerText()).trim();
  expect(/^GW[A-Z2-9]{10}$/.test(id), 'bad order id ' + id);
  await shot('20-collections-qr');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: 'Pending' }).click();
  await page.getByRole('row', { name: new RegExp(id) }).waitFor();
});

await step('mailbox: defines a template from a sample, tests it, saves, validates with a sample and activates it', async () => {
  await page.goto(`${WEB}/admin/mailbox`);
  await page.getByRole('button', { name: 'New template' }).click();
  const dlg = page.getByRole('dialog', { name: 'New alert template' });
  await dlg.getByLabel('Template name').fill('testbank-credit');
  await dlg.getByLabel('Bank name').fill('TestBank (synthetic)');
  await dlg.getByLabel(/Sender address/).fill('alerts@testbank.example');
  await dlg.getByLabel(/DKIM signing domain/).fill('testbank.example');
  await dlg.getByLabel(/A credit is recognised by/).fill('credited to your a/c');
  await dlg.getByLabel(/Amount \(regex/).fill('Rs\\.? ?([\\d,]+(?:\\.\\d{1,2})?) credited');
  await dlg.getByLabel(/Bank transaction reference/).fill('Ref No (\\d{12})');
  await dlg.getByLabel(/Credit date\/time text/).fill('on (\\d{2}-\\d{2}-\\d{4} \\d{2}:\\d{2}:\\d{2})');
  const sample = 'Dear Customer, Rs. 1,250.00 credited to your a/c XX1234 on 13-10-2026 11:02:33 by UPI. Ref No 612345678901. VPA payer.one@okhdfc. -TestBank';
  await dlg.getByLabel('Email text').fill(sample);
  expect(await dlg.getByRole('button', { name: 'Save template' }).isDisabled(), 'Save must stay disabled until the sample parses');
  await dlg.getByRole('button', { name: 'Test on this sample' }).click();
  await dlg.getByText(/Parsed: ₹1,250.00, reference 612345678901/).waitFor();
  await shot('21-template-test');
  await dlg.getByRole('button', { name: 'Save template' }).click();
  await maybeStepUp();
  await dlg.waitFor({ state: 'detached', timeout: 10000 });
  const row = page.getByRole('row', { name: /testbank-credit/ });
  await row.getByText('NOT YET').waitFor();
  await row.getByRole('button', { name: /Validate with a real sample/ }).click();
  const v = page.getByRole('dialog', { name: /Validate/ });
  await v.getByLabel('Email text').fill(sample);
  await v.getByRole('button', { name: 'Validate' }).click();
  await maybeStepUp();
  await v.waitFor({ state: 'detached', timeout: 10000 });
  await page.getByRole('row', { name: /testbank-credit/ }).getByRole('button', { name: 'Activate' }).click();
  await maybeStepUp();
  await page.getByRole('row', { name: /testbank-credit/ }).getByText('ACTIVE').waitFor();
  await shot('22-template-active');
});

await step('mailbox: an uploaded unsigned "bank" email is REJECTED by the authenticity check and credits nothing', async () => {
  const eml = 'From: TestBank <alerts@testbank.example>\r\nTo: owner@example.test\r\nSubject: Credit alert\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\nMessage-ID: <ui-forged@testbank.example>\r\n\r\nDear Customer, Rs. 1,250.00 credited to your a/c XX1234 on 13-10-2026 15:30:00 by UPI. Ref No 999999999999. Remark: Order GWAAAAAAAAAA.\r\n';
  await page.goto(`${WEB}/admin/mailbox`);
  await page.getByLabel('Upload .eml').setInputFiles({ name: 'forged.eml', mimeType: 'message/rfc822', buffer: Buffer.from(eml) });
  await maybeStepUp();
  await page.getByText('dkim not passing', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.getByRole('row', { name: /AUTH FAILED/ }).first().waitFor();
  await shot('23-forged-rejected');
  await page.goto(`${WEB}/admin/collections`);
  await page.getByRole('tab', { name: 'Unmatched transactions' }).click();
  await page.getByText('No unmatched transactions.').waitFor();
});

await step('collections: a missing alert never marks an order paid; a manual attestation needs a DIFFERENT administrator', async () => {
  await page.goto(`${WEB}/admin/collections`);
  await page.getByRole('tab', { name: 'Pending' }).click();
  await page.getByRole('button', { name: 'Alert missing?' }).first().click();
  const dlg = page.getByRole('dialog', { name: /Alert missing/ });
  await dlg.getByLabel(/Bank transaction reference/).fill('412345678901');
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await dlg.getByLabel(/Credit date and time/).fill(local);
  await dlg.getByLabel(/Which statement line/).fill('Statement line 7 in the bank portal');
  await dlg.getByRole('button', { name: 'Propose' }).click();
  await maybeStepUp();
  await dlg.waitFor({ state: 'detached', timeout: 10000 });
  await page.getByText('Manual attestations waiting for a second administrator').waitFor();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Approve' }).click();
  await maybeStepUp();
  await page.getByText(/different administrator/i).waitFor({ timeout: 10000 }); // the proposer cannot approve their own
  await shot('24-dual-control');
  await page.getByRole('tab', { name: 'Paid' }).click();
  await page.getByText(/No paid orders/).waitFor();
});

await step('no browser console errors', async () => { expect(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ')); });

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI steps passed`);
process.exit(failed.length ? 1 : 0);
