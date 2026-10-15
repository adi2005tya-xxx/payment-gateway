/**
 * Throughput / contention test on a REAL PostgreSQL server (disposable local cluster, synthetic data, simulated bank).
 *   npx ts-node scripts/pg-scratch.ts start   # prints TEST_PG_URL
 *   TEST_PG_URL=... npx ts-node scripts/load-test.ts [payments=1500] [merchants=20] [concurrency=16] [workers=8]
 * Verifies correctness under concurrency (no duplicate journals, all invariants hold) AND reports measured rates.
 * Results are machine- and configuration-specific; they are measurements, not capacity guarantees.
 */
import { randomBytes, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from 'pg';
import { migrate } from '../src/db/db';
import { PgDb } from '../src/db/pg.db';
import { createPlatform } from '../src/platform';
import { SandboxBankAccountProvider } from '../src/provider/sandbox-bank.provider';
import { summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { drillSecurity } from '../src/recovery/seed';

const [paymentsArg, merchantsArg, concArg, workersArg] = process.argv.slice(2);
const PAYMENTS = Number(paymentsArg ?? 1500);
const MERCHANTS = Number(merchantsArg ?? 20);
const CONC = Number(concArg ?? 16);
const WORKERS = Number(workersArg ?? 8);
const admin = process.env.TEST_PG_URL;
if (!admin) throw new Error('TEST_PG_URL is required (see header)');

/** Runs fn over items with bounded concurrency; returns per-item latencies (ms). */
async function pool<T>(items: T[], conc: number, fn: (x: T, i: number) => Promise<void>): Promise<number[]> {
  const lat: number[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < items.length) {
        const i = next++;
        const t = process.hrtime.bigint();
        await fn(items[i], i);
        lat[i] = Number(process.hrtime.bigint() - t) / 1e6;
      }
    }),
  );
  return lat;
}
const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
const round = (x: number) => Math.round(x * 10) / 10;

async function main() {
  const name = `load_${randomBytes(4).toString('hex')}`;
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = new URL(admin!);
  url.pathname = `/${name}`;
  const db = new PgDb(url.toString());
  try {
    await migrate(db);
    const provider = new SandboxBankAccountProvider('load-webhook-secret-123456', 'http://localhost:3001', 'load@sandboxbank', { openingBalanceMinor: 0 });
    const p = createPlatform(db, provider, drillSecurity());
    const [adm] = await db.query<any>(`INSERT INTO users(email, password_hash, role) VALUES ('load-admin@example.test','x','ADMIN') RETURNING id`);
    const adminActor = { id: adm.id, role: 'ADMIN' };

    // --- setup merchants
    const merchants: Array<{ id: string; actor: any }> = [];
    for (let i = 0; i < MERCHANTS; i++) {
      const reg = await p.merchants.register({ email: `lm${i}-${randomUUID().slice(0, 4)}@example.test`, passwordHash: 'x', legalName: 'Load Merchant Pvt Ltd', displayName: `Load ${i}` });
      await p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', adminActor);
      const actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
      provider.setVpaHolder(`load${i}@okhdfc`, 'LOAD MERCHANT');
      const d = await p.merchants.addUpiDestination(reg.merchantId, `load${i}@okhdfc`, actor);
      await p.merchants.verifyDestination(d.id, adminActor);
      await db.query('UPDATE merchants SET review_threshold_minor=100000000000, per_payout_limit_minor=100000000000, daily_payout_limit_minor=100000000000 WHERE id=$1', [reg.merchantId]);
      merchants.push({ id: reg.merchantId, actor });
    }

    // --- phase 1: payment requests + bank credits arriving (webhook ingest) concurrently
    const jobs = Array.from({ length: PAYMENTS }, (_, i) => ({ m: merchants[i % MERCHANTS], amount: 10_000 + (i % 50) * 100 }));
    const tIngest = Date.now();
    const ingestLat = await pool(jobs, CONC, async (j, i) => {
      const req = await p.requests.create(j.m.id, { orderReference: `L-${i}`, amountMinor: j.amount }, j.m.actor);
      const sim = provider.simulateBankCredit(req.provider_order_id);
      await p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    });
    const ingestMs = Date.now() - tIngest;

    // --- phase 2: verification workers (several competing workers on the shared queue)
    const tVerify = Date.now();
    await Promise.all(Array.from({ length: WORKERS }, () => p.jobs.drain(p.handlers, new Date(), 100000)));
    const verifyMs = Date.now() - tVerify;
    const [ok] = await db.query<any>(`SELECT COUNT(*)::int n FROM payments WHERE status='SUCCEEDED'`);
    const [pending] = await db.query<any>(`SELECT COUNT(*)::int n FROM jobs WHERE status IN ('PENDING','RUNNING')`);

    // --- phase 3: payouts for every merchant concurrently, plus duplicate-submission attempts with the same key
    const tPayout = Date.now();
    const payLat = await pool(merchants, CONC, async (m) => {
      await Promise.all([1, 2, 3].map(() => p.payouts.request(m.id, { idempotencyKey: `load-${m.id}` }, m.actor))); // same key x3: must create one
    });
    // the owner account must hold the money for the payouts to be sent
    provider.topUp(10_000_000_000);
    await Promise.all(Array.from({ length: WORKERS }, () => p.jobs.drain(p.handlers, new Date(), 100000)));
    const payoutMs = Date.now() - tPayout;

    // --- correctness
    const dupJournals = await db.query(`SELECT 1 FROM ledger_journals GROUP BY kind, ref_type, ref_id HAVING COUNT(*)>1`);
    const [po] = await db.query<any>(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE status='SUCCEEDED')::int ok FROM payouts`);
    const integrity = summarize(await verifyFinancialIntegrity(db));
    const recon = await p.reconciliation.run();

    const result = {
      measuredAt: new Date().toISOString(),
      config: { payments: PAYMENTS, merchants: MERCHANTS, clientConcurrency: CONC, workers: WORKERS, pgPoolMax: 10 },
      ingest: { ms: ingestMs, perSec: round((PAYMENTS / ingestMs) * 1000), p50: round(pct(ingestLat, 0.5)), p95: round(pct(ingestLat, 0.95)), p99: round(pct(ingestLat, 0.99)), note: 'payment request + webhook signature check + durable store + enqueue' },
      verification: { ms: verifyMs, perSec: round((PAYMENTS / verifyMs) * 1000), succeeded: ok.n, jobsLeft: pending.n, note: 'provider lookup + matching + atomic ledger posting, competing workers' },
      payouts: { ms: payoutMs, merchants: MERCHANTS, created: po.n, succeeded: po.ok, p50: round(pct(payLat, 0.5)), p95: round(pct(payLat, 0.95)), note: '3 concurrent identical requests per merchant, then submission' },
      correctness: { duplicateJournals: dupJournals.length, integrityChecks: integrity.total, integrityFailures: integrity.failures.map((f) => f.name), reconciliationDiscrepancies: recon.discrepancies },
    };
    console.log(JSON.stringify(result, null, 2));
    writeFileSync(resolve('..', 'docs', 'load-test-results.json'), JSON.stringify(result, null, 2));
    const bad = ok.n !== PAYMENTS || pending.n !== 0 || dupJournals.length || !integrity.ok || po.n !== MERCHANTS || po.ok !== MERCHANTS || recon.discrepancies !== 0;
    if (bad) {
      console.error('LOAD TEST FOUND A CORRECTNESS PROBLEM');
      process.exitCode = 1;
    }
  } finally {
    await db.close();
    const d = new Client({ connectionString: admin });
    await d.connect();
    await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await d.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
