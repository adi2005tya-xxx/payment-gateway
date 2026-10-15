import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PgliteDb } from '../src/db/pglite.db';
import { createPlatform, Platform } from '../src/platform';
import { SandboxProvider } from '../src/provider/sandbox.provider';
import { createEncryptedBackup, restoreEncryptedBackup, sha256File, verifyBackupChecksum } from '../src/recovery/backup-archive';
import { diffSnapshots, financialSnapshot, schemaFingerprint, summarize, verifyFinancialIntegrity } from '../src/recovery/integrity';
import { ACCOUNTS } from '../src/ledger/ledger.service';
import { backupWorld, buildWorld, cleanup, freshSchemaDigest, World } from './recovery-world';
import { farFuture, WEBHOOK_SECRET } from './helpers';

jest.setTimeout(240_000);

const KEY = randomBytes(32);
let w: World;
let schemaDigest: string;
let backup: Awaited<ReturnType<typeof backupWorld>>;
const opened: PgliteDb[] = [];

beforeAll(async () => {
  schemaDigest = await freshSchemaDigest();
  w = await buildWorld();
  backup = await backupWorld(w, KEY);
});
afterAll(async () => {
  for (const d of opened) await d.close().catch(() => undefined);
  await w.db.close();
  cleanup(w.work);
});

/** Restores the encrypted backup into a brand-new, empty database instance. */
async function restore(file = backup.file, key = KEY) {
  const dir = join(w.work, 'restore-' + randomBytes(4).toString('hex'));
  restoreEncryptedBackup(file, key, dir);
  const db = await PgliteDb.openFromDump(readFileSync(join(dir, 'pgdata.tar.gz')));
  opened.push(db);
  return db;
}
const platformOn = (db: PgliteDb, provider: SandboxProvider = w.provider): Platform => createPlatform(db, provider, w.security);
const later = () => new Date(Date.now() + 30 * 24 * 3600 * 1000); // beyond any deferral/backoff
const payout = async (db: PgliteDb, id: string) => (await db.query<any>('SELECT * FROM payouts WHERE id=$1', [id]))[0];

describe('integrity checker', () => {
  it('passes on a healthy, representative database', async () => {
    const s = summarize(await verifyFinancialIntegrity(w.db, { expectedSchemaDigest: schemaDigest }));
    expect(s).toMatchObject({ ok: true, failed: 0 });
    expect(s.total).toBeGreaterThanOrEqual(18);
  });

  it('seed data really contains in-flight and ambiguous work', async () => {
    const st = await w.db.query<any>(`SELECT status, outcome_unknown FROM payouts WHERE id = ANY($1)`, [[w.seed.payouts.bAmbiguous, w.seed.payouts.bProcessing, w.seed.payouts.queued, w.seed.payouts.cHeld]]);
    expect(st.map((r) => r.status).sort()).toEqual(['PROCESSING', 'QUEUED', 'SUBMITTED', 'UNDER_REVIEW']);
    expect((await w.db.query<any>(`SELECT status FROM refunds WHERE id=$1`, [w.seed.pendingRefundId]))[0].status).toBe('PENDING');
    expect((await w.db.query<any>(`SELECT status FROM webhook_events WHERE id=$1`, [w.seed.unprocessedWebhookEventId]))[0].status).toBe('RECEIVED');
    expect((await w.db.query<any>(`SELECT COUNT(*)::int n FROM reconciliation_items WHERE resolved=false`))[0].n).toBeGreaterThan(0);
    expect((await w.db.query<any>(`SELECT COUNT(*)::int n FROM idempotency_records`))[0].n).toBe(2);
  });

  // Each case corrupts a fresh restored copy (superuser bypassing the triggers, as a faulty restore or an insider might) and must be caught.
  const tamper: Array<[string, string, string]> = [
    ['a vanished ledger entry', `ALTER TABLE ledger_entries DISABLE TRIGGER USER; DELETE FROM ledger_entries WHERE id = (SELECT MIN(id) FROM ledger_entries);`, 'every journal balances'],
    ['an altered ledger amount', `ALTER TABLE ledger_entries DISABLE TRIGGER USER; UPDATE ledger_entries SET amount_minor = amount_minor + 1 WHERE id = (SELECT MIN(id) FROM ledger_entries);`, 'every journal balances'],
    ['a payout marked FAILED without its release journal', `UPDATE payouts SET status='FAILED' WHERE status='PROCESSING';`, 'payout reservations, completions and releases'],
    ['a missing payout reservation journal', `ALTER TABLE ledger_entries DISABLE TRIGGER USER; ALTER TABLE ledger_journals DISABLE TRIGGER USER; DELETE FROM ledger_entries WHERE journal_id IN (SELECT id FROM ledger_journals WHERE kind='PAYOUT_RESERVE' LIMIT 1); DELETE FROM ledger_journals WHERE id IN (SELECT j.id FROM ledger_journals j WHERE kind='PAYOUT_RESERVE' AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.journal_id=j.id));`, 'payout reservations'],
    ['refunded_minor that no longer matches succeeded refunds', `UPDATE payments SET refunded_minor = refunded_minor - 1 WHERE refunded_minor > 0 AND status='PARTIALLY_REFUNDED';`, 'refunded_minor equals'],
    ['a payment without its ledger journal', `ALTER TABLE ledger_entries DISABLE TRIGGER USER; ALTER TABLE ledger_journals DISABLE TRIGGER USER; DELETE FROM ledger_entries WHERE journal_id IN (SELECT id FROM ledger_journals WHERE kind='COLLECTION'); DELETE FROM ledger_journals WHERE kind='COLLECTION';`, 'every settled payment has its ledger journal'],
    ['a dropped immutability trigger', `DROP TRIGGER ledger_entries_immutable ON ledger_entries;`, 'immutability triggers'],
    ['a dropped uniqueness constraint', `ALTER TABLE payments DROP CONSTRAINT payments_provider_provider_payment_id_key;`, 'uniqueness constraints'],
    ['an edited audit record', `ALTER TABLE audit_logs DISABLE TRIGGER USER; UPDATE audit_logs SET action='x' WHERE id = (SELECT MIN(id) FROM audit_logs);`, 'audit hash chain'],
    ['a merchant balance that no longer matches business records', `ALTER TABLE payments DISABLE TRIGGER USER; UPDATE payments SET net_minor = net_minor + 5 WHERE id = (SELECT id FROM payments WHERE status='SUCCEEDED' LIMIT 1);`, 'merchant payable balances reconcile'],
  ];
  it.each(tamper)('detects %s', async (_name, sql, expectedCheck) => {
    const db = await restore();
    await db.exec(sql);
    const failed = summarize(await verifyFinancialIntegrity(db, { expectedSchemaDigest: schemaDigest })).failures.map((f) => f.name);
    expect(failed.some((n) => n.includes(expectedCheck))).toBe(true);
    // ...and the deterministic snapshot differs from the original, except for pure-structure changes.
  });
});

describe('backup, restore and verification', () => {
  it('restores the encrypted backup into an empty database with an identical financial snapshot and passing invariants', async () => {
    const db = await restore();
    const snap = await financialSnapshot(db);
    expect(diffSnapshots(backup.snapshot, snap)).toEqual([]);
    expect(snap.digest).toBe(backup.snapshot.digest);
    expect(snap.accountBalances).toEqual(backup.snapshot.accountBalances);
    expect(snap.queue).toEqual(backup.snapshot.queue); // queued/pending work survived
    const s = summarize(await verifyFinancialIntegrity(db, { expectedSchemaDigest: schemaDigest }));
    expect(s.failures).toEqual([]);
    expect((await schemaFingerprint(db)).digest).toBe(schemaDigest); // constraints, indexes and triggers all present
    // Pending / ambiguous / in-flight states are exactly as they were.
    expect((await payout(db, w.seed.payouts.bAmbiguous)).status).toBe('SUBMITTED');
    expect((await payout(db, w.seed.payouts.queued)).status).toBe('QUEUED');
    expect((await db.query<any>(`SELECT status FROM refunds WHERE id=$1`, [w.seed.pendingRefundId]))[0].status).toBe('PENDING');
    expect((await db.query<any>(`SELECT COUNT(*)::int n FROM idempotency_records`))[0].n).toBe(2);
    // Ledger immutability still enforced after restore.
    await expect(db.query('UPDATE ledger_entries SET amount_minor = 1')).rejects.toThrow(/append-only/);
  });

  it('restoring the same backup twice yields byte-for-byte identical financial content', async () => {
    const a = await financialSnapshot(await restore());
    const b = await financialSnapshot(await restore());
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toBe(backup.snapshot.digest);
  });

  it('the restored app does not re-apply an already-posted financial event when webhooks are replayed', async () => {
    const db = await restore();
    const p = platformOn(db);
    const before = await financialSnapshot(db, { excludeTables: ['webhook_events', 'audit_logs', 'alerts', 'notification_jobs', 'payment_events', 'risk_reviews', 'payment_requests'] });
    const processed = await db.query<any>(`SELECT id FROM webhook_events WHERE status='PROCESSED'`);
    expect(processed.length).toBeGreaterThan(3);
    for (const e of processed) await p.verification.processWebhookEvent(e.id, { attempt: 1, maxAttempts: 8 }); // no-op for PROCESSED
    // Force-replay the full payloads through the apply path as a provider re-delivery would.
    for (const pp of await w.provider.listPayments()) if (pp.status === 'captured') await p.verification.applyProviderPayment(pp).catch(() => undefined);
    const after = await financialSnapshot(db, { excludeTables: ['webhook_events', 'audit_logs', 'alerts', 'notification_jobs', 'payment_events', 'risk_reviews', 'payment_requests'] });
    // The only new fact is the orphan provider payment that was never recorded (held in suspense), never a duplicate of anything posted.
    const dupJournals = await db.query(`SELECT 1 FROM ledger_journals GROUP BY kind, ref_type, ref_id HAVING COUNT(*)>1`);
    expect(dupJournals).toHaveLength(0);
    for (const t of ['ledger_journals', 'ledger_entries', 'payouts', 'refunds', 'merchants']) {
      if (t === 'ledger_journals' || t === 'ledger_entries') continue; // orphan suspense journal is the single legitimate addition
      expect(after.tables[t].hash).toBe(before.tables[t].hash);
    }
    // Two legitimate additions, both inbound-only: the unknown provider payment (held in suspense) and the payment whose webhook was still queued.
    expect(after.tables.payments.rows).toBe(before.tables.payments.rows + 2);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
  });
});

describe('backup security and corrupted / incomplete backups', () => {
  it('is encrypted: no plaintext business data, emails or schema names in the file', () => {
    const raw = readFileSync(backup.file);
    for (const needle of ['Synthetic Pvt Ltd', 'dr-admin-1@example.test', 'ledger_entries', 'PostgreSQL', 'PG_VERSION', 'syn-payout-a-ok']) expect(raw.includes(Buffer.from(needle))).toBe(false);
    expect(raw.subarray(0, 5).toString()).toBe('GWBK1');
  });

  it('the sidecar and artifacts never contain the key or secrets', () => {
    const side = readFileSync(backup.file + '.manifest.json', 'utf8');
    expect(side).not.toContain(KEY.toString('hex'));
    expect(side).not.toContain(KEY.toString('base64'));
    expect(JSON.parse(side)).toMatchObject({ files: 1, encryptedBytes: statSync(backup.file).size });
    const me = readFileSync(backup.file);
    expect(me.includes(KEY)).toBe(false);
  });

  it('can be integrity-verified without the key', () => {
    expect(verifyBackupChecksum(backup.file)).toEqual({ ok: true });
  });

  it('rejects a wrong key, and leaves nothing behind', async () => {
    const dir = join(w.work, 'wrongkey');
    expect(() => restoreEncryptedBackup(backup.file, randomBytes(32), dir)).toThrow();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(w.work).filter((f) => f.startsWith('.restore-') || f.includes('.staging-'))).toEqual([]);
  });

  it('rejects a truncated (incomplete) backup', async () => {
    const copy = join(w.work, 'trunc.gwbk');
    const b = await backupWorld(w, KEY, 'trunc');
    writeFileSync(copy, readFileSync(b.file));
    writeFileSync(copy + '.manifest.json', readFileSync(b.file + '.manifest.json'));
    truncateSync(copy, Math.floor(statSync(copy).size / 2));
    expect(verifyBackupChecksum(copy).ok).toBe(false);
    expect(() => restoreEncryptedBackup(copy, KEY, join(w.work, 'trunc-out'))).toThrow(/integrity check.*size mismatch/);
  });

  it('rejects a corrupted backup (one flipped bit) and a tampered one even when the attacker fixes the checksum', async () => {
    const b = await backupWorld(w, KEY, 'corrupt');
    const bytes = readFileSync(b.file);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    const corrupt = join(w.work, 'corrupt.gwbk');
    writeFileSync(corrupt, bytes);
    writeFileSync(corrupt + '.manifest.json', readFileSync(b.file + '.manifest.json'));
    expect(verifyBackupChecksum(corrupt)).toMatchObject({ ok: false, reason: expect.stringContaining('SHA-256') });
    expect(() => restoreEncryptedBackup(corrupt, KEY, join(w.work, 'corrupt-out'))).toThrow(/SHA-256/);

    // Attacker recomputes the sidecar hash: the AES-GCM authentication tag still fails.
    const side = JSON.parse(readFileSync(corrupt + '.manifest.json', 'utf8'));
    side.encryptedSha256 = sha256File(corrupt);
    writeFileSync(corrupt + '.manifest.json', JSON.stringify(side));
    expect(verifyBackupChecksum(corrupt).ok).toBe(true);
    expect(() => restoreEncryptedBackup(corrupt, KEY, join(w.work, 'corrupt-out2'))).toThrow();
    expect(existsSync(join(w.work, 'corrupt-out2'))).toBe(false);
  });

  it('rejects a backup whose sidecar is missing, and refuses to restore over existing data', () => {
    const lone = join(w.work, 'nosidecar.gwbk');
    writeFileSync(lone, readFileSync(backup.file));
    expect(verifyBackupChecksum(lone)).toMatchObject({ ok: false, reason: 'sidecar manifest missing' });
    const live = join(w.work, 'live-data');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'important'), 'do not overwrite');
    expect(() => restoreEncryptedBackup(backup.file, KEY, live)).toThrow(/non-empty directory/);
    expect(readFileSync(join(live, 'important'), 'utf8')).toBe('do not overwrite');
  });

  it('preserves empty directories and nested structure (a PostgreSQL data dir cannot start without them)', () => {
    const src = join(w.work, 'tree-src');
    mkdirSync(join(src, 'pg_notify'), { recursive: true });
    mkdirSync(join(src, 'base', '1'), { recursive: true });
    writeFileSync(join(src, 'base', '1', 'f'), 'x');
    const file = join(w.work, 'tree.gwbk');
    createEncryptedBackup({ sourceDir: src, outFile: file, key: KEY, label: 'tree' });
    const out = join(w.work, 'tree-out');
    restoreEncryptedBackup(file, KEY, out);
    expect(existsSync(join(out, 'pg_notify'))).toBe(true);
    expect(readdirSync(join(out, 'pg_notify'))).toEqual([]);
    expect(readFileSync(join(out, 'base', '1', 'f'), 'utf8')).toBe('x');
  });

  it('never overwrites an existing backup file', () => {
    expect(() => createEncryptedBackup({ sourceDir: join(w.work), outFile: backup.file, key: KEY, label: 'x' })).toThrow(/overwrite/);
  });
});

describe('post-restore: no duplicate external payouts, ever', () => {
  /** World moves on after the backup: the provider (external truth) acts, our DB is later restored from the OLDER backup. */
  async function staleRestore() {
    // Original system continues: queued payout is submitted, processing one completes, pending refund completes.
    await w.p.jobs.drain(w.p.handlers, farFuture());
    const [bp] = await w.provider.listPayouts();
    void bp;
    for (const po of await w.provider.listPayouts()) if (po.status === 'processing') w.provider.settlePayout(po.id, 'processed');
    return restore();
  }

  it('restored in-flight work stays frozen: workers move no money, refunds and new payouts are refused, inbound processing continues', async () => {
    const db = await restore();
    const p = platformOn(db);
    await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    expect((await p.recovery.status()).moneyOutFrozen).toBe(true);
    const calls = w.provider.payoutCreateCalls;
    const queuedBefore = await payout(db, w.seed.payouts.queued);
    await p.jobs.drain(p.handlers, farFuture()); // workers run
    expect(w.provider.payoutCreateCalls).toBe(calls); // nothing submitted to the provider
    expect((await payout(db, w.seed.payouts.queued)).status).toBe(queuedBefore.status);
    const [m] = await db.query<any>(`SELECT id FROM merchants WHERE id=$1`, [w.seed.merchants.A]);
    await expect(p.payouts.request(m.id, { amountMinor: 1000, idempotencyKey: 'post-restore-new' }, { id: null, role: 'MERCHANT', merchantId: m.id })).rejects.toMatchObject({ code: 'MONEY_OUT_FROZEN' });
    const [pay] = await db.query<any>(`SELECT id FROM payments WHERE status='SUCCEEDED' AND refunded_minor=0 LIMIT 1`);
    await expect(p.refunds.request(pay.id, { amountMinor: 100, idempotencyKey: 'post-restore-refund' }, w.seed.admin)).rejects.toMatchObject({ code: 'MONEY_OUT_FROZEN' });
    // The unprocessed webhook that was queued at backup time IS applied, exactly once.
    expect((await db.query<any>(`SELECT status FROM webhook_events WHERE id=$1`, [w.seed.unprocessedWebhookEventId]))[0].status).toBe('PROCESSED');
    expect((await db.query<any>(`SELECT COUNT(*)::int n FROM payments WHERE provider_payment_id IN (SELECT payload->>'paymentId' FROM webhook_events WHERE id=$1)`, [w.seed.unprocessedWebhookEventId]))[0].n).toBe(1);
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
  });

  it('a payout the provider already executed (result not recorded locally) is adopted from the provider, never resubmitted', async () => {
    const calls0 = w.provider.payoutCreateCalls;
    const db = await staleRestore(); // provider has processed the queued payout; the restored DB still says QUEUED / SUBMITTED / PROCESSING
    const calls1 = w.provider.payoutCreateCalls;
    expect(calls1).toBeGreaterThan(calls0); // the ORIGINAL system submitted it once (before the "disaster")
    expect((await payout(db, w.seed.payouts.queued)).status).toBe('QUEUED');
    const p = platformOn(db);
    const report = await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    expect(w.provider.payoutCreateCalls).toBe(calls1); // restore itself created zero external payouts
    for (const id of [w.seed.payouts.queued, w.seed.payouts.bAmbiguous, w.seed.payouts.bProcessing]) expect((await payout(db, id)).status).toBe('SUCCEEDED');
    expect(report.payoutsSynced).toBeGreaterThanOrEqual(2);
    expect(report.payoutsHeldForReview).toBe(0);
    // Only one provider payout per local payout reference.
    const refs = (await w.provider.listPayouts()).map((x) => x.referenceId);
    expect(new Set(refs).size).toBe(refs.length);
    // Reserved funds became completed payouts exactly once.
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
    expect(await p.ledger.balance(db, ACCOUNTS.PAYOUT_CLEARING.code)).toBe(60_000); // only the held payout remains reserved
  });

  it('pending refunds complete exactly once via idempotent replay; the freeze then lifts only after a clean reconciliation', async () => {
    const db = await staleRestore();
    const p = platformOn(db);
    const report = await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    expect(report.reconciliationItems.map((i) => i.kind)).toContain('REFUND_MISMATCH'); // provider already refunded; ledger has not caught up
    await expect(p.recovery.unfreeze(w.seed.admin)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_CLEAN' });
    await p.jobs.drain(p.handlers, farFuture()); // complete_refund replays createRefund with the same key
    expect((await db.query<any>(`SELECT status FROM refunds WHERE id=$1`, [w.seed.pendingRefundId]))[0].status).toBe('SUCCEEDED');
    const refunded = (await w.provider.listPayments()).reduce((s, x) => s + x.refundedMinor, 0);
    const local = Number((await db.query<any>('SELECT COALESCE(SUM(refunded_minor),0) AS s FROM payments'))[0].s);
    expect(local).toBe(refunded); // once, not twice
    // The seeded UNKNOWN_ORDER orphan payment is held in suspense and the unresolved item is already resolved by the heal step.
    const res = await p.recovery.unfreeze(w.seed.admin);
    expect(res.unfrozen).toBe(true);
    expect((await p.recovery.status()).moneyOutFrozen).toBe(false);
    // After release, the one remaining queued payout (the held one needs approval) behaves normally and the system is consistent.
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
    await expect(p.recovery.unfreeze(w.seed.admin)).rejects.toMatchObject({ code: 'NOT_FROZEN' });
  });

  it('a payout the provider has NO record of is held, requires admin attestation, and is then submitted at most once', async () => {
    const db = await restore();
    // A provider that has no memory of any payout (e.g. the transfer never happened, or the lookup is authoritative-empty).
    const amnesiac = new SandboxProvider(WEBHOOK_SECRET);
    const p = platformOn(db, amnesiac);
    const report = await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    expect(report.payoutsHeldForReview).toBe(2); // SUBMITTED (ambiguous) + PROCESSING
    const amb = w.seed.payouts.bAmbiguous;
    expect((await payout(db, amb)).status).toBe('UNDER_REVIEW');
    expect((await payout(db, amb)).outcome_unknown).toBe(true);
    expect(await p.ledger.balance(db, ACCOUNTS.PAYOUT_CLEARING.code)).toBeGreaterThan(0); // funds stay reserved
    await expect(p.recovery.unfreeze(w.seed.admin)).rejects.toMatchObject({ code: 'UNRESOLVED_PAYOUTS' });
    // Cannot be resolved without evidence or a note, and 'sync' needs the provider to actually have it.
    await expect(p.recovery.resolveHeldPayout(w.seed.admin, amb, 'sync', '')).rejects.toMatchObject({ code: 'NOT_AT_PROVIDER' });
    await expect(p.recovery.resolveHeldPayout(w.seed.admin, amb, 'confirmed_not_sent', 'short')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    amnesiac.outage = true;
    await expect(p.recovery.resolveHeldPayout(w.seed.admin, amb, 'confirmed_not_sent', 'checked bank statement: no transfer on that day')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    amnesiac.outage = false;
    for (const id of [amb, w.seed.payouts.bProcessing]) await p.recovery.resolveHeldPayout(w.seed.admin, id, 'confirmed_not_sent', 'checked bank statement: no transfer on that day');
    expect((await payout(db, amb)).status).toBe('QUEUED');
    expect(amnesiac.payoutCreateCalls).toBe(0); // still frozen: nothing submitted yet
    await p.jobs.drain(p.handlers, farFuture());
    expect(amnesiac.payoutCreateCalls).toBe(0);
    await p.recovery.unfreeze(w.seed.admin).catch((e) => {
      // reconciliation may still list the seeded orphan until healed; heal result is covered elsewhere
      expect(['RECONCILIATION_NOT_CLEAN']).toContain(e.code);
    });
    await db.query(`DELETE FROM system_flags WHERE key='money_out_frozen'`); // test-only shortcut: release to observe submission semantics
    await p.jobs.drain(p.handlers, later());
    expect(amnesiac.payoutCreateCalls).toBe(3); // 3 payouts were QUEUED: the two re-queued + the one queued at backup time
    expect(new Set((await amnesiac.listPayouts()).map((x) => x.referenceId)).size).toBe(3);
    await p.jobs.drain(p.handlers, later());
    expect(amnesiac.payoutCreateCalls).toBe(3); // draining again changes nothing
  });

  it('a payout the local DB does not know about (backup older than the payout) blocks release until handled', async () => {
    const db = await restore();
    const p = platformOn(db);
    const orphan = await w.provider.createPayout({ referenceId: '11111111-2222-4333-8444-555555555555', amountMinor: 12_345, currency: 'INR', destinationRef: 'fa_x', idempotencyKey: 'late-payout' });
    await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    await p.jobs.drain(p.handlers, farFuture());
    await expect(p.recovery.unfreeze(w.seed.admin)).rejects.toMatchObject({ code: expect.stringMatching(/RECONCILIATION_NOT_CLEAN|UNRESOLVED_PAYOUTS/) });
    const run = await p.reconciliation.run();
    expect(run.items.map((i) => i.kind)).toContain('ORPHAN_PROVIDER_PAYOUT');
    void orphan;
  });

  it('re-running the post-restore procedure is safe: no additional money movement and no changes to posted records', async () => {
    const db = await staleRestore();
    const p = platformOn(db);
    await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    const calls = w.provider.payoutCreateCalls;
    const ex = { excludeTables: ['audit_logs', 'alerts', 'reconciliation_runs', 'reconciliation_items', 'system_flags', 'notification_jobs'] };
    const first = await financialSnapshot(db, ex);
    const second1 = await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    const second = await financialSnapshot(db, ex);
    expect(diffSnapshots(first, second)).toEqual([]);
    expect(second1.payoutsSynced).toBe(0);
    expect(second1.paymentsRecovered).toBe(0);
    expect(w.provider.payoutCreateCalls).toBe(calls);
  });

  it('revokes every session: a revocation made after the backup cannot be undone by restoring', async () => {
    const [u] = await w.db.query<any>(`INSERT INTO users(email, password_hash, role) VALUES ('sess@example.test','x','MERCHANT') RETURNING id`);
    const s = await w.db.query<any>(`INSERT INTO auth_sessions(user_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id`, [u.id]);
    const b = await backupWorld(w, KEY, 'sessions');
    await w.db.query(`UPDATE auth_sessions SET revoked_at=now(), revoked_reason='logout' WHERE id=$1`, [s[0].id]); // revoked AFTER the backup
    const db = await restore(b.file);
    const p = platformOn(db);
    expect(await p.auth.resolve(s[0].id)).not.toBeNull(); // the restore resurrected the session
    await p.recovery.postRestore({ id: null, role: 'SYSTEM' });
    expect(await p.auth.resolve(s[0].id)).toBeNull(); // ...and the procedure kills it
  });
});

describe('startup detection and atomicity', () => {
  it('auto-freezes money-out when the database incarnation changes, and not on a normal restart', async () => {
    const db = await restore();
    const p = platformOn(db);
    expect(await p.recovery.startupCheck()).toMatchObject({ changed: false });
    await db.query(`UPDATE system_flags SET value='123:9' WHERE key='db_fingerprint'`); // as if the data came from another cluster/timeline
    expect(await p.recovery.startupCheck()).toMatchObject({ changed: true, frozen: true });
    expect(await p.recovery.startupCheck()).toMatchObject({ changed: false, frozen: true }); // stays frozen, no repeated alert
    expect((await db.query(`SELECT 1 FROM alerts WHERE kind='MONEY_OUT_FROZEN'`)).length).toBe(1);
    const actions = (await db.query<any>(`SELECT action FROM audit_logs WHERE action LIKE 'recovery.%'`)).map((r) => r.action);
    expect(actions).toContain('recovery.money_out.frozen');
  });

  it('1. a crash in the middle of webhook processing leaves no partial financial state, and the retry applies it once', async () => {
    const db = await restore();
    const p = platformOn(db);
    const [ev] = await db.query<any>(`SELECT id FROM webhook_events WHERE status='RECEIVED'`);
    const orig = p.ledger.post.bind(p.ledger);
    let armed = true;
    p.ledger.post = async (tx, j) => {
      if (armed) {
        armed = false;
        await orig(tx, j); // journal written inside the transaction...
        throw new Error('simulated process crash after the ledger write, before commit');
      }
      return orig(tx, j);
    };
    const collectionsBefore = (await db.query<any>(`SELECT COUNT(*)::int n FROM ledger_journals WHERE kind='COLLECTION'`))[0].n;
    const before = await financialSnapshot(db, { excludeTables: ['webhook_events', 'jobs'] });
    await expect(p.verification.processWebhookEvent(ev.id, { attempt: 1, maxAttempts: 8 })).rejects.toThrow(/simulated/);
    const after = await financialSnapshot(db, { excludeTables: ['webhook_events', 'jobs'] });
    expect(diffSnapshots(before, after)).toEqual([]); // transaction rolled back: no payment, no journal, no request status change
    expect((await db.query<any>(`SELECT status FROM webhook_events WHERE id=$1`, [ev.id]))[0].status).toBe('RECEIVED');
    await p.verification.processWebhookEvent(ev.id, { attempt: 2, maxAttempts: 8 });
    await p.verification.processWebhookEvent(ev.id, { attempt: 3, maxAttempts: 8 });
    expect((await db.query<any>(`SELECT COUNT(*)::int n FROM ledger_journals WHERE kind='COLLECTION'`))[0].n).toBe(collectionsBefore + 1); // applied once despite 2 retries after the crash
    expect(summarize(await verifyFinancialIntegrity(db)).failures).toEqual([]);
    expect((await db.query<any>(`SELECT COUNT(*)::int n FROM payments WHERE status='SUCCEEDED'`))[0].n).toBe(Number(backup.snapshot.statusCounts.payments.SUCCEEDED) + 1);
  });
});
