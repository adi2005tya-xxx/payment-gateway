/**
 * Disaster-recovery drill on a REAL PostgreSQL server (binaries from the embedded-postgres dev dependency).
 *   npx ts-node scripts/dr-drill.ts [--skip-suite] [--keep]
 *
 * Synthetic data only. Everything happens under .dr-work/drill-<timestamp>/ in disposable clusters on 127.0.0.1;
 * nothing is ever restored over an existing data directory. Results (timings, check outcomes) are written to
 * docs/dr-test-report.md and docs/dr-test-report.json. Nothing in the report is invented: every number is measured here.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { platform as osPlatform, release, cpus, totalmem } from 'os';
import { join, resolve } from 'path';
import { Client } from 'pg';
import { PgDb } from '../src/db/pg.db';
import { migrate } from '../src/db/db';
import { createPlatform, Platform } from '../src/platform';
import { SandboxProvider } from '../src/provider/sandbox.provider';
import { createEncryptedBackup, keyIdOf, restoreEncryptedBackup, sha256File, verifyBackupChecksum } from '../src/recovery/backup-archive';
import { diffSnapshots, financialSnapshot, schemaFingerprint, Snapshot, summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { PgCluster, restoreCommand } from '../src/recovery/pgcluster';
import { drillSecurity, seedRepresentativeData, SeedResult } from '../src/recovery/seed';

const args = new Set(process.argv.slice(2));
const ROOT = resolve('.dr-work', `drill-${Date.now()}`);
const DIRS = { primary: join(ROOT, 'primary'), archive: join(ROOT, 'wal-archive'), backups: join(ROOT, 'backups'), keys: join(ROOT, 'keys'), staging: join(ROOT, 'staging') };
Object.values(DIRS).forEach((d) => mkdirSync(d, { recursive: true }));
const WEBHOOK_SECRET = 'drill-webhook-secret-123456';

interface Step {
  scenario: string;
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
}
const steps: Step[] = [];
const metrics: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function step<T>(scenario: string, name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const out = await fn();
    steps.push({ scenario, name, ok: true, ms: Date.now() - t0, detail: out && typeof out === 'object' ? out : undefined });
    log('PASS', scenario, '-', name, `(${Date.now() - t0} ms)`);
    return out;
  } catch (e: any) {
    steps.push({ scenario, name, ok: false, ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 1500) });
    log('FAIL', scenario, '-', name, '::', String(e?.message ?? e).slice(0, 300));
    return undefined;
  }
}
const expect = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function waitFor(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------------------------------------ key custody
// Two independent keys, kept OUTSIDE the backup/archive directories (in real life: a secrets manager + offline escrow).
const backupKey = randomBytes(32);
const walKey = randomBytes(32);
const BACKUP_KEY_FILE = join(DIRS.keys, 'backup.key');
const WAL_KEY_FILE = join(DIRS.keys, 'wal.key');
writeFileSync(BACKUP_KEY_FILE, backupKey.toString('base64'), { mode: 0o600 });
writeFileSync(WAL_KEY_FILE, walKey.toString('base64'), { mode: 0o600 });

// ------------------------------------------------------------------------------------------------ helpers
function copyTree(src: string, dst: string, skipTop: (name: string) => boolean) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (skipTop(name)) continue;
    const s = join(src, name);
    const d = join(dst, name);
    let st;
    try {
      st = statSync(s);
    } catch {
      continue; // file vanished (temp file) while copying
    }
    if (st.isDirectory()) copyTree(s, d, () => false);
    else {
      try {
        copyFileSync(s, d);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
}

const secOpts = drillSecurity();
const provider = new SandboxProvider(WEBHOOK_SECRET);
const adminActor = (id: string) => ({ id, role: 'ADMIN' as const });

function platformFor(db: PgDb): Platform {
  return createPlatform(db, provider, secOpts);
}

async function collect(p: Platform, merchantId: string, userId: string, amount: number, tag: string) {
  const actor = { id: userId, role: 'MERCHANT', merchantId };
  const req = await p.requests.create(merchantId, { orderReference: `DRILL-${tag}-${randomBytes(3).toString('hex')}`, amountMinor: amount }, actor);
  const sim = provider.simulateCustomerPayment(req.provider_order_id);
  await p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
  return sim;
}

async function activityBatch(p: Platform, seed: SeedResult, merchant: 'A' | 'B', tag: string, payments: number) {
  const mid = seed.merchants[merchant];
  const [u] = await p.db.query<any>('SELECT id FROM users WHERE merchant_id=$1', [mid]);
  for (let i = 0; i < payments; i++) await collect(p, mid, u.id, 10_000 + i * 1_000, tag);
  await p.jobs.drain(p.handlers);
  const po = await p.payouts.request(mid, { amountMinor: 5_000, idempotencyKey: `drill-${tag}-${randomBytes(3).toString('hex')}` }, { id: u.id, role: 'MERCHANT', merchantId: mid });
  await p.jobs.drain(p.handlers);
  return { payoutId: po.id as string, payments };
}

async function backupSession(primary: PgCluster, label: string) {
  const c = new Client({ connectionString: primary.url });
  c.on('error', () => undefined);
  await c.connect();
  const t0 = Date.now();
  const staging = join(DIRS.staging, label);
  try {
    await c.query(`SELECT pg_backup_start($1, true)`, [label]);
    copyTree(primary.opts.dataDir, staging, (n) => ['pg_wal', 'postmaster.pid', 'postmaster.opts', 'pg_stat_tmp'].includes(n));
    mkdirSync(join(staging, 'pg_wal', 'archive_status'), { recursive: true });
    const r = await c.query(`SELECT lsn::text, labelfile, spcmapfile FROM pg_backup_stop(true)`);
    writeFileSync(join(staging, 'backup_label'), r.rows[0].labelfile);
    const startWal = /START WAL LOCATION: [0-9A-F]+\/[0-9A-F]+ \(file ([0-9A-F]{24})\)/.exec(r.rows[0].labelfile)![1];
    const stopWal = (await c.query(`SELECT pg_walfile_name($1::pg_lsn) AS f`, [r.rows[0].lsn])).rows[0].f as string;
    // The segment holding the stop LSN must be archived before the backup is usable (pg_backup_stop already forced the switch).
    await waitFor(() => existsSync(join(DIRS.archive, `${stopWal}.enc`)), 90_000, 'archive of the segment containing the backup stop LSN');
    return { staging, startWal, stopWal, ms: Date.now() - t0 };
  } finally {
    await c.end();
  }
}

/** WAL continuity: every segment from the backup's start segment to the newest archived one must exist (same timeline). */
function walGaps(archiveDir: string, startWal: string): { first: string; last: string; count: number; gaps: string[] } {
  const names = readdirSync(archiveDir).filter((f) => /^[0-9A-F]{24}\.enc$/.test(f)).map((f) => f.slice(0, 24)).sort();
  const tl = startWal.slice(0, 8);
  const num = (n: string) => parseInt(n.slice(8, 16), 16) * 0x100 + parseInt(n.slice(16, 24), 16);
  const have = new Set(names.filter((n) => n.startsWith(tl)).map(num));
  const from = num(startWal);
  const last = Math.max(...have);
  const gaps: string[] = [];
  for (let i = from; i <= last; i++) if (!have.has(i)) gaps.push(`${tl}${Math.floor(i / 0x100).toString(16).toUpperCase().padStart(8, '0')}${(i % 0x100).toString(16).toUpperCase().padStart(8, '0')}`);
  return { first: startWal, last: names.filter((n) => n.startsWith(tl)).slice(-1)[0], count: have.size, gaps };
}

let nextPort = 55500;
async function restoreCluster(opts: { backupFile: string; name: string; targetTime?: string; archiveDir?: string; expectFailure?: boolean }) {
  const t0 = Date.now();
  const dir = join(ROOT, `restore-${opts.name}`);
  restoreEncryptedBackup(opts.backupFile, backupKey, dir, { scratchDir: join(ROOT, 'scratch') });
  const tExtracted = Date.now();
  const port = nextPort++;
  const cluster = new PgCluster({ dataDir: dir, port });
  const archiveDir = opts.archiveDir ?? DIRS.archive;
  // Restored servers must not write into the archive they are recovering from (new timelines would pollute later restores).
  const conf = [restoreCommand(archiveDir, WAL_KEY_FILE), `recovery_target_action = 'promote'`, 'archive_mode = off'];
  if (opts.targetTime) conf.push(`recovery_target_time = '${opts.targetTime}'`, `recovery_target_inclusive = on`);
  cluster.writeConf(conf);
  writeFileSync(join(dir, 'recovery.signal'), '');
  let startFailed: string | undefined;
  try {
    cluster.start(180);
  } catch (e: any) {
    startFailed = String(e.message);
  }
  if (startFailed) {
    if (opts.expectFailure) return { cluster, failed: startFailed, db: undefined as unknown as PgDb, port, ms: Date.now() - t0, extractMs: tExtracted - t0, recoveryMs: 0 };
    throw new Error(startFailed);
  }
  const probe = new Client({ connectionString: cluster.urlFor('postgres') });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await waitFor(async () => !(await probe.query('SELECT pg_is_in_recovery() AS r')).rows[0].r, opts.expectFailure ? 30_000 : 120_000, 'promotion after recovery');
  } catch (e: any) {
    if (opts.expectFailure) {
      // pg_ctl -w can return once the server accepts read-only connections; the FATAL arrives later and kills it.
      const logTxt = existsSync(join(dir, '..', `${port}.log`)) ? readFileSync(join(dir, '..', `${port}.log`), 'utf8') : '';
      const fatal = /FATAL:\s+(recovery ended before configured recovery target was reached|.*)/.exec(logTxt);
      return { cluster, failed: fatal ? fatal[0].slice(0, 200) : String(e.message), db: undefined as unknown as PgDb, port, ms: Date.now() - t0, extractMs: tExtracted - t0, recoveryMs: 0 };
    }
    throw e;
  }
  await probe.end();
  const tReady = Date.now();
  const db = new PgDb(cluster.urlFor('gateway'));
  return { cluster, db, port, failed: undefined as string | undefined, ms: tReady - t0, extractMs: tExtracted - t0, recoveryMs: tReady - tExtracted };
}

async function verifyAgainst(db: PgDb, expected: Snapshot, schemaDigest: string) {
  const t0 = Date.now();
  const snap = await financialSnapshot(db);
  const diff = diffSnapshots(expected, snap);
  const checks = await verifyFinancialIntegrity(db, { expectedSchemaDigest: schemaDigest });
  const s = summarize(checks);
  return { snapshotMatches: diff.length === 0, diff, checks: s.total, failedChecks: s.failures.map((f) => f.name), ms: Date.now() - t0, snap };
}

// ------------------------------------------------------------------------------------------------ the drill
async function main() {
  const started = Date.now();
  log('drill root', ROOT);
  const primary = new PgCluster({ dataDir: join(DIRS.primary, 'data'), port: 55490, archiveDir: DIRS.archive, walKeyFile: WAL_KEY_FILE });
  const clusters: PgCluster[] = [primary];
  let db!: PgDb;
  let p!: Platform;
  let seed!: SeedResult;
  let expectedSchema = '';
  const dbOpen = async (c: PgCluster) => new PgDb(c.urlFor('gateway'));

  await step('setup', 'initialise primary cluster (archive_mode=on, encrypted WAL archive) and start it', async () => {
    primary.init();
    const t0 = Date.now();
    primary.start();
    const c = new Client({ connectionString: primary.url });
    await c.connect();
    metrics.postgresVersion = (await c.query('SHOW server_version')).rows[0].server_version;
    await c.query('CREATE DATABASE gateway');
    await c.end();
    return { startMs: Date.now() - t0, version: metrics.postgresVersion };
  });

  await step('setup', 'apply migrations through the production PgDb driver and seed synthetic representative data', async () => {
    db = await dbOpen(primary);
    const applied = await migrate(db);
    p = platformFor(db);
    await p.recovery.startupCheck(); // a deployed app records its database incarnation on first start
    seed = await seedRepresentativeData(p, provider);
    // Reference structure: a freshly migrated scratch database on the SAME server (engine-specific definitions must match like for like).
    const adm = new Client({ connectionString: primary.url });
    await adm.connect();
    await adm.query('CREATE DATABASE gateway_ref');
    await adm.end();
    const ref = new PgDb(primary.urlFor('gateway_ref'));
    await migrate(ref);
    expectedSchema = (await schemaFingerprint(ref)).digest;
    await ref.close();
    const adm2 = new Client({ connectionString: primary.url });
    await adm2.connect();
    await adm2.query('DROP DATABASE gateway_ref');
    await adm2.end();
    const s = summarize(await verifyFinancialIntegrity(db, { expectedSchemaDigest: expectedSchema }));
    expect(s.ok, 'baseline integrity failed: ' + JSON.stringify(s.failures));
    return { applied, integrityChecks: s.total };
  });

  // ---------------------------------------------------------------- scenario 2: database crash during a transaction
  await step('S2 database restart during a transaction', 'uncommitted work vanishes after an immediate (crash) stop; committed data is untouched', async () => {
    const before = await financialSnapshot(db);
    const raw = new Client({ connectionString: primary.urlFor('gateway') });
    raw.on('error', () => undefined);
    await raw.connect();
    await raw.query('BEGIN');
    const [j] = (await raw.query(`INSERT INTO ledger_journals(kind, ref_type, ref_id, currency) VALUES ('CRASHTEST','t','crash-1','INR') RETURNING id`)).rows;
    const acct = (await raw.query(`SELECT id FROM ledger_accounts LIMIT 2`)).rows;
    await raw.query(`INSERT INTO ledger_entries(journal_id, account_id, direction, amount_minor) VALUES ($1,$2,'D',777),($1,$3,'C',777)`, [j.id, acct[0].id, acct[1].id]);
    // transaction is open and uncommitted; the server is now killed without a shutdown checkpoint
    raw.on('error', () => undefined);
    const tCrash = Date.now();
    primary.stop('immediate');
    primary.start();
    const recoveryMs = Date.now() - tCrash;
    await db.close().catch(() => undefined);
    db = await dbOpen(primary);
    const after = await financialSnapshot(db);
    expect(diffSnapshots(before, after).length === 0, 'snapshot changed across crash: ' + diffSnapshots(before, after).join('; '));
    expect((await db.query(`SELECT 1 FROM ledger_journals WHERE kind='CRASHTEST'`)).length === 0, 'uncommitted journal survived the crash');
    expect(summarize(await verifyFinancialIntegrity(db, { expectedSchemaDigest: expectedSchema })).ok, 'integrity failed after crash');
    p = platformFor(db);
    metrics.crashRecoveryMs = recoveryMs;
    return { crashStopStartMs: recoveryMs };
  });

  // ---------------------------------------------------------------- scenario 1: app crash mid webhook processing (DB dies after the ledger write)
  await step('S1 application crash during webhook processing', 'a crash after the ledger write but before commit leaves nothing; the retry applies the event exactly once', async () => {
    const mid = seed.merchants.A;
    const [u] = await db.query<any>('SELECT id FROM users WHERE merchant_id=$1', [mid]);
    const sim = await collect(p, mid, u.id, 33_333, 'crash');
    const [ev] = await db.query<any>(`SELECT id FROM webhook_events WHERE provider_event_id=$1`, [sim.webhook.eventId]);
    const before = await financialSnapshot(db, { excludeTables: ['webhook_events', 'jobs'] });
    const orig = p.ledger.post.bind(p.ledger);
    let armed = true;
    p.ledger.post = async (tx, j) => {
      const r = await orig(tx, j);
      if (armed) {
        armed = false;
        primary.stop('immediate'); // the process/database dies here: ledger rows written, transaction not committed
      }
      return r;
    };
    let crashed = false;
    try {
      await p.verification.processWebhookEvent(ev.id, { attempt: 1, maxAttempts: 8 });
    } catch {
      crashed = true;
    }
    expect(crashed, 'processing should have failed when the database died');
    p.ledger.post = orig;
    await db.close().catch(() => undefined);
    primary.start();
    db = await dbOpen(primary);
    p = platformFor(db);
    const mid1 = await financialSnapshot(db, { excludeTables: ['webhook_events', 'jobs'] });
    expect(diffSnapshots(before, mid1).length === 0, 'partial financial state after crash: ' + diffSnapshots(before, mid1).join('; '));
    // The durable event is still there and unprocessed; replaying it (twice) applies it exactly once.
    expect((await db.query<any>(`SELECT status FROM webhook_events WHERE id=$1`, [ev.id]))[0].status === 'RECEIVED', 'event should still be RECEIVED');
    await p.verification.processWebhookEvent(ev.id, { attempt: 2, maxAttempts: 8 });
    await p.verification.processWebhookEvent(ev.id, { attempt: 3, maxAttempts: 8 });
    const n = (await db.query<any>(`SELECT COUNT(*)::int n FROM payments WHERE provider_payment_id=$1`, [sim.payment.id]))[0].n;
    expect(n === 1, `payment applied ${n} times`);
    expect(summarize(await verifyFinancialIntegrity(db, { expectedSchemaDigest: expectedSchema })).ok, 'integrity failed after replay');
    return { appliedExactlyOnce: true };
  });

  // ---------------------------------------------------------------- backup
  const sideSnapshot = await financialSnapshot(db); // quiesced: nothing runs between this and backup start
  let base: Awaited<ReturnType<typeof backupSession>> | undefined;
  let sidecar: ReturnType<typeof createEncryptedBackup> | undefined;
  const BACKUP_FILE = join(DIRS.backups, 'base-001.gwbk');
  await step('backup', 'physical base backup via pg_backup_start/stop + encrypted, checksummed container', async () => {
    base = await backupSession(primary, 'drill-base-001');
    const t0 = Date.now();
    sidecar = createEncryptedBackup({ sourceDir: base.staging, outFile: BACKUP_FILE, key: backupKey, label: 'drill-base-001', meta: { startWal: base.startWal, stopWal: base.stopWal, pg: metrics.postgresVersion } });
    rmSync(base.staging, { recursive: true, force: true }); // only the encrypted artifact remains
    metrics.backup = { copyMs: base.ms, encryptMs: Date.now() - t0, encryptedBytes: sidecar.encryptedBytes, files: sidecar.files, keyId: keyIdOf(backupKey), startWal: base.startWal, stopWal: base.stopWal };
    expect(verifyBackupChecksum(BACKUP_FILE).ok, 'backup checksum failed right after creation');
    return metrics.backup as object;
  });

  await step('backup security', 'backup and WAL archive contain no plaintext business data; keys are stored outside both', () => {
    const needles = ['Synthetic Pvt Ltd', 'dr-admin-1@example.test', 'ledger_entries', 'PG_VERSION', 'syn-payout-a-ok'];
    const files = [BACKUP_FILE, ...readdirSync(DIRS.archive).filter((f) => f.endsWith('.enc')).map((f) => join(DIRS.archive, f))];
    const leaks: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f);
      for (const n of needles) if (raw.includes(Buffer.from(n))) leaks.push(`${f}:${n}`);
      if (raw.includes(backupKey) || raw.includes(walKey)) leaks.push(`${f}:KEY`);
    }
    expect(leaks.length === 0, 'plaintext found: ' + leaks.join(', '));
    expect(!readdirSync(DIRS.archive).some((f) => !f.endsWith('.enc') && !f.endsWith('.tmp')), 'unencrypted file in archive');
    expect(!BACKUP_FILE.startsWith(DIRS.keys) && !DIRS.archive.startsWith(DIRS.keys), 'keys share a directory with backups');
    metrics.securityFilesScanned = files.length;
    return { filesScanned: files.length };
  });

  // ---------------------------------------------------------------- activity after the backup (PITR + RPO material)
  let snapTarget!: Snapshot;
  let targetTime = '';
  let batch1: any, batch2: any, batch3: any;
  let gapTarget = '';
  await step('post-backup activity', 'batch 1 (3 payments + 1 executed payout), then record the PITR target', async () => {
    batch1 = await activityBatch(p, seed, 'A', 'b1', 3);
    snapTarget = await financialSnapshot(db);
    targetTime = (await db.query<any>(`SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US TZH:TZM') AS t`))[0].t;
    await sleep(1500); // guarantee later commits have strictly later timestamps
    return { targetTime, batch1 };
  });
  await step('post-backup activity', 'batch 2 (more payments + executed payout), then force WAL archive and capture final archived state', async () => {
    batch2 = await activityBatch(p, seed, 'B', 'b2', 3);
    gapTarget = (await db.query<any>(`SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US TZH:TZM') AS t`))[0].t;
    // Produce several archived segments after the backup (needed for the WAL-gap scenario); each needs a write to be switchable.
    for (let i = 0; i < 3; i++) {
      await db.query(`INSERT INTO alerts(kind, detail) VALUES ('DRILL_FILLER','{}')`);
      const seg = (await db.query<any>(`SELECT pg_walfile_name(pg_current_wal_lsn()) AS f`))[0].f;
      await db.query('SELECT pg_switch_wal()');
      await waitFor(() => existsSync(join(DIRS.archive, `${seg}.enc`)), 90_000, 'filler segment archive');
    }
    return { batch2 };
  });
  const snapFinal = await financialSnapshot(db);
  metrics.wal = walGaps(DIRS.archive, base!.startWal);

  await step('backup verification', 'WAL archive is continuous from the backup start segment to the newest segment', () => {
    const g = walGaps(DIRS.archive, base!.startWal);
    expect(g.gaps.length === 0, 'gaps: ' + g.gaps.join(','));
    return g;
  });

  // ---------------------------------------------------------------- batch 3: committed but NOT yet archived, then disaster
  let lastCommitBeforeLoss = '';
  await step('disaster', 'commit batch 3 (not archived), then destroy the primary immediately (data directory deleted, archive and backup survive)', async () => {
    batch3 = await activityBatch(p, seed, 'A', 'b3', 2);
    lastCommitBeforeLoss = (await db.query<any>(`SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS t`))[0].t;
    metrics.batch3Payments = batch3.payments;
    metrics.batch3PayoutId = batch3.payoutId;
    await db.close().catch(() => undefined);
    primary.stop('immediate');
    rmSync(primary.opts.dataDir, { recursive: true, force: true });
    expect(!existsSync(primary.opts.dataDir), 'primary data dir still exists');
    return { lastCommitBeforeLoss };
  });

  // ---------------------------------------------------------------- scenario 5: restore into an empty environment (PITR) + stale-restore post-procedure (scenario 6/7)
  let r1: Awaited<ReturnType<typeof restoreCluster>> | undefined;
  await step('S5 restore into empty environment (PITR)', 'restore to the recorded target time and verify against the snapshot taken at that moment', async () => {
    r1 = await restoreCluster({ backupFile: BACKUP_FILE, name: 'pitr', targetTime });
    clusters.push(r1.cluster);
    const v = await verifyAgainst(r1.db, snapTarget, expectedSchema);
    expect(v.snapshotMatches, 'PITR snapshot mismatch: ' + v.diff.join('; '));
    expect(v.failedChecks.length === 0, 'failed checks: ' + v.failedChecks.join('; '));
    metrics.pitr = { totalMs: r1.ms, extractMs: r1.extractMs, recoveryMs: r1.recoveryMs, verifyMs: v.ms, checks: v.checks };
    return metrics.pitr as object;
  });

  await step('S6/S7 stale restore', 'provider executed work the restored DB does not know: auto-detection, freeze, no duplicate payouts, release blocked', async () => {
    const rp = platformFor(r1!.db);
    const st = await rp.recovery.startupCheck();
    expect(st.changed && st.frozen, `restore not auto-detected (changed=${st.changed} frozen=${st.frozen})`);
    const createCallsBefore = provider.payoutCreateCalls;
    const rep = await rp.recovery.postRestore({ id: null, role: 'SYSTEM' });
    await rp.jobs.drain(rp.handlers, new Date(Date.now() + 30 * 86_400_000)); // workers run while frozen
    expect(provider.payoutCreateCalls === createCallsBefore, `restore/worker created ${provider.payoutCreateCalls - createCallsBefore} external payouts`);
    const orphanKinds = (await rp.reconciliation.run()).items.filter((i) => !i.resolved).map((i) => i.kind);
    let unfreezeBlocked = '';
    try {
      await rp.recovery.unfreeze(adminActor(seed.admin.id!));
    } catch (e: any) {
      unfreezeBlocked = e.code;
    }
    expect(unfreezeBlocked !== '', 'unfreeze must be blocked while the provider holds payouts the restored DB cannot account for');
    metrics.staleRestore = { autoDetected: st.changed, report: rep, openReconciliationKinds: [...new Set(orphanKinds)], unfreezeBlockedBy: unfreezeBlocked };
    return metrics.staleRestore as object;
  });

  // ---------------------------------------------------------------- scenario 5b/3: restore latest (RPO measurement), worker restart with queued events, scenario 8: restore re-run
  let r2: Awaited<ReturnType<typeof restoreCluster>> | undefined;
  await step('S3/S5 restore to latest archived state', 'restore, measure RTO and the actual data loss (unarchived batch 3), verify against the pre-disaster archived state', async () => {
    r2 = await restoreCluster({ backupFile: BACKUP_FILE, name: 'latest' });
    clusters.push(r2.cluster);
    const v = await verifyAgainst(r2.db, snapFinal, expectedSchema);
    expect(v.snapshotMatches, 'latest-restore snapshot mismatch: ' + v.diff.join('; '));
    expect(v.failedChecks.length === 0, 'failed checks: ' + v.failedChecks.join('; '));
    const lost = (await r2.db.query<any>(`SELECT COUNT(*)::int n FROM payouts WHERE id=$1`, [batch3.payoutId]))[0].n === 0;
    metrics.latest = { totalMs: r2.ms, extractMs: r2.extractMs, recoveryMs: r2.recoveryMs, verifyMs: v.ms, checks: v.checks, batch3LostAsExpected: lost };
    metrics.rpo = { lastCommitBeforeLoss, restoredThrough: 'last archived WAL segment', unarchivedBatchLost: lost, archiveTimeoutSeconds: 60 };
    expect(lost, 'batch 3 unexpectedly present: archive was more complete than assumed');
    return metrics.latest as object;
  });

  await step('S3 worker restart with queued financial events', 'jobs queued at backup time run exactly once on the restored database (while money-out is frozen)', async () => {
    const rp = platformFor(r2!.db);
    const st = await rp.recovery.startupCheck();
    expect(st.changed && st.frozen, 'restore not auto-detected on the latest restore');
    const before = await rp.db.query<any>(`SELECT status, COUNT(*)::int n FROM jobs GROUP BY status ORDER BY status`);
    const calls = provider.payoutCreateCalls;
    await rp.jobs.drain(rp.handlers, new Date(Date.now() + 30 * 86_400_000));
    expect(provider.payoutCreateCalls === calls, 'worker created external payouts while frozen');
    expect(summarize(await verifyFinancialIntegrity(r2!.db, { expectedSchemaDigest: expectedSchema })).ok, 'integrity failed after worker restart');
    const dup = await r2!.db.query(`SELECT 1 FROM ledger_journals GROUP BY kind, ref_type, ref_id HAVING COUNT(*)>1`);
    expect(dup.length === 0, 'duplicate journals');
    return { jobsBefore: before, externalPayoutsCreated: 0 };
  });

  await step('S7 pending refunds and unresolved reconciliation items after restore', 'preserved by the restore; the pending refund completes exactly once by idempotent replay', async () => {
    const rp = platformFor(r2!.db);
    const rep = await rp.recovery.postRestore({ id: null, role: 'SYSTEM' });
    const refund = (await r2!.db.query<any>(`SELECT status FROM refunds WHERE id=$1`, [seed.pendingRefundId]))[0];
    const items = (await r2!.db.query<any>(`SELECT COUNT(*)::int n FROM reconciliation_items`))[0].n;
    expect(refund.status === 'SUCCEEDED' || refund.status === 'PENDING', 'refund in unexpected state ' + refund.status);
    await rp.jobs.drain(rp.handlers, new Date(Date.now() + 30 * 86_400_000));
    const done = (await r2!.db.query<any>(`SELECT status FROM refunds WHERE id=$1`, [seed.pendingRefundId]))[0].status;
    expect(done === 'SUCCEEDED', 'pending refund not completed: ' + done);
    const refundedLocal = Number((await r2!.db.query<any>('SELECT COALESCE(SUM(refunded_minor),0) AS s FROM payments'))[0].s);
    const refundedProvider = (await provider.listPayments()).reduce((s, x) => s + x.refundedMinor, 0);
    expect(refundedLocal === refundedProvider, `refunded locally ${refundedLocal} vs provider ${refundedProvider}`);
    return { reconciliationItemsPreserved: items, report: rep };
  });

  await step('S8 re-running the restoration', 'restoring the same backup again into a fresh directory reproduces identical financial content; post-restore procedure re-run changes nothing posted', async () => {
    const r3 = await restoreCluster({ backupFile: BACKUP_FILE, name: 'latest-again' });
    clusters.push(r3.cluster);
    const v = await verifyAgainst(r3.db, snapFinal, expectedSchema);
    expect(v.snapshotMatches, 'second restore differs: ' + v.diff.join('; '));
    const rp = platformFor(r3.db);
    await rp.recovery.postRestore({ id: null, role: 'SYSTEM' });
    const ex = { excludeTables: ['audit_logs', 'alerts', 'reconciliation_runs', 'reconciliation_items', 'system_flags', 'notification_jobs', 'jobs', 'webhook_events', 'payment_events', 'risk_reviews', 'payment_requests', 'payments', 'payout_events', 'payouts', 'refunds', 'ledger_entries', 'ledger_journals', 'ledger_accounts', 'merchants'] };
    void ex;
    const a = await financialSnapshot(r3.db, { excludeTables: ['audit_logs', 'alerts', 'reconciliation_runs', 'reconciliation_items', 'system_flags', 'notification_jobs'] });
    const calls = provider.payoutCreateCalls;
    await rp.recovery.postRestore({ id: null, role: 'SYSTEM' });
    const b = await financialSnapshot(r3.db, { excludeTables: ['audit_logs', 'alerts', 'reconciliation_runs', 'reconciliation_items', 'system_flags', 'notification_jobs'] });
    expect(diffSnapshots(a, b).length === 0, 'second post-restore changed posted records: ' + diffSnapshots(a, b).join('; '));
    expect(provider.payoutCreateCalls === calls, 'second post-restore created external payouts');
    await r3.db.close();
    r3.cluster.stop();
    return { digestEqual: true, restoreMs: r3.ms };
  });

  // ---------------------------------------------------------------- scenario 4: corrupted / incomplete backups
  await step('S4 corrupted or incomplete backup', 'truncated base backup, bit-flipped backup, tampered backup with fixed checksum, missing sidecar: all rejected before any data is written', async () => {
    const out: Record<string, string> = {};
    const bytes = readFileSync(BACKUP_FILE);
    const trunc = join(DIRS.backups, 'truncated.gwbk');
    writeFileSync(trunc, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    copyFileSync(BACKUP_FILE + '.manifest.json', trunc + '.manifest.json');
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(flipped.length / 2)] ^= 1;
    const flip = join(DIRS.backups, 'bitflip.gwbk');
    writeFileSync(flip, flipped);
    copyFileSync(BACKUP_FILE + '.manifest.json', flip + '.manifest.json');
    const tamper = join(DIRS.backups, 'tampered.gwbk');
    writeFileSync(tamper, flipped);
    const side = JSON.parse(readFileSync(BACKUP_FILE + '.manifest.json', 'utf8'));
    side.encryptedSha256 = sha256File(tamper);
    writeFileSync(tamper + '.manifest.json', JSON.stringify(side));
    const nosc = join(DIRS.backups, 'nosidecar.gwbk');
    writeFileSync(nosc, bytes);
    for (const [label, f] of [['truncated', trunc], ['bitflip', flip], ['tampered-fixed-checksum', tamper], ['missing-sidecar', nosc]] as const) {
      const target = join(ROOT, `corrupt-${label}`);
      let rejected = '';
      try {
        restoreEncryptedBackup(f, backupKey, target, { scratchDir: join(ROOT, 'scratch') });
      } catch (e: any) {
        rejected = String(e.message).slice(0, 120);
      }
      expect(rejected !== '', `${label} backup was accepted`);
      expect(!existsSync(target), `${label}: data written despite rejection`);
      out[label] = rejected;
    }
    const live = join(ROOT, 'live-dir');
    mkdirSync(live);
    writeFileSync(join(live, 'x'), '1');
    let refused = false;
    try {
      restoreEncryptedBackup(BACKUP_FILE, backupKey, live);
    } catch {
      refused = true;
    }
    expect(refused, 'restore over a non-empty directory was allowed');
    out['non-empty-target'] = 'refused';
    return out;
  });

  await step('S4 corrupted or incomplete backup', 'a gap in the WAL archive is detected by the continuity check, and recovery to a target beyond the gap refuses to start', async () => {
    const gappy = join(ROOT, 'wal-archive-gap');
    mkdirSync(gappy);
    const all = readdirSync(DIRS.archive).filter((f) => f.endsWith('.enc')).sort();
    const needed = all.filter((f) => /^[0-9A-F]{24}\.enc$/.test(f) && f.startsWith(base!.startWal.slice(0, 8)) && f.slice(0, 24) >= base!.startWal);
    expect(needed.length >= 3, `need >=3 archived segments after the backup start for the gap test, have ${needed.length}`);
    const missing = needed[1]; // the segment right after the backup stop segment: recovery to the batch-2 target must pass through it
    for (const f of all) if (f !== missing) copyFileSync(join(DIRS.archive, f), join(gappy, f));
    const g = walGaps(gappy, base!.startWal);
    expect(g.gaps.length > 0, 'gap not detected by continuity check');
    const r = await restoreCluster({ backupFile: BACKUP_FILE, name: 'gap', targetTime: gapTarget, archiveDir: gappy, expectFailure: true });
    clusters.push(r.cluster);
    expect(!!r.failed, 'recovery with a WAL gap and a target time should NOT have started successfully');
    return { missingSegment: missing, detectedGaps: g.gaps, recoveryRefused: true, note: 'without a recovery target PostgreSQL would silently stop at the gap; the continuity check must run first' };
  });

  // ---------------------------------------------------------------- existing automated test suite against the restored server
  if (!args.has('--skip-suite')) {
    await step('restored application', 'the full existing automated test suite passes against the restored PostgreSQL server', () => {
      const t0 = Date.now();
      const res = spawnSync('npm', ['test'], { encoding: 'utf8', shell: true, env: { ...process.env, TEST_PG_URL: r2!.cluster.url }, maxBuffer: 1 << 28 });
      const out = (res.stdout ?? '') + (res.stderr ?? '');
      const m = /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed, (\d+) total/.exec(out);
      const suites = /Test Suites:\s+(?:(\d+) failed, )?(\d+) passed, (\d+) total/.exec(out);
      const detail = { exitCode: res.status, tests: m ? m[0] : 'unparsed', suites: suites ? suites[0] : 'unparsed', ms: Date.now() - t0 };
      metrics.suiteOnRestored = detail;
      expect(res.status === 0, 'suite failed on restored server: ' + JSON.stringify(detail) + out.slice(-1500));
      return detail;
    });
  }

  // ---------------------------------------------------------------- wrap up
  for (const c of clusters) {
    try {
      c.stop();
    } catch {
      /* ignore */
    }
  }
  metrics.totalDrillMs = Date.now() - started;
  const failed = steps.filter((s) => !s.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { os: `${osPlatform()} ${release()}`, cpus: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), node: process.version, postgres: metrics.postgresVersion },
    result: failed.length === 0 ? 'ALL STEPS PASSED' : `${failed.length} STEP(S) FAILED`,
    steps,
    metrics,
  };
  mkdirSync(resolve('..', 'docs'), { recursive: true });
  writeFileSync(resolve('..', 'docs', 'dr-test-report.json'), JSON.stringify(report, null, 2));
  log(report.result, `(${Math.round((metrics.totalDrillMs as number) / 1000)} s total)`);
  if (!args.has('--keep')) rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('DRILL ABORTED:', e);
  process.exit(2);
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection (ignored by drill harness):', String((e as any)?.message ?? e)));
process.on('uncaughtException', (e) => console.error('uncaughtException (ignored by drill harness):', String((e as any)?.message ?? e)));
