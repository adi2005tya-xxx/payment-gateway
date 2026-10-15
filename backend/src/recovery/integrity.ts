import { createHash } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import { Queryable } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { LedgerService, ACCOUNTS } from '../ledger/ledger.service';

export interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const num = (v: unknown) => Number(v ?? 0);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Tables whose content defines the financial truth. Order keys make snapshots deterministic. */
export const FINANCIAL_TABLES: Array<[string, string]> = [
  ['merchants', 'id'],
  ['merchant_settlement_destinations', 'id'],
  ['payment_requests', 'id'],
  ['payments', 'id'],
  ['payment_events', 'id'],
  ['webhook_events', 'id'],
  ['ledger_accounts', 'id'],
  ['ledger_journals', 'id'],
  ['ledger_entries', 'id'],
  ['payouts', 'id'],
  ['payout_events', 'id'],
  ['refunds', 'id'],
  ['disputes', 'id'],
  ['reconciliation_runs', 'id'],
  ['reconciliation_items', 'id'],
  ['risk_reviews', 'id'],
  ['idempotency_records', 'scope, key'],
  ['audit_logs', 'id'],
  ['alerts', 'id'],
  ['notification_jobs', 'id'],
  ['system_flags', 'key'],
];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Snapshot {
  digest: string;
  tables: Record<string, { rows: number; hash: string }>;
  accountBalances: Record<string, number>;
  merchantPayables: Record<string, number>;
  statusCounts: Record<string, Record<string, number>>;
  queue: Record<string, number>;
}

/**
 * Deterministic financial summary: a content hash of every financial table (not row counts), plus derived
 * balances. Two databases with identical snapshots hold identical financial records.
 */
export async function financialSnapshot(q: Queryable, opts: { excludeTables?: string[] } = {}): Promise<Snapshot> {
  const tables: Snapshot['tables'] = {};
  for (const [t, order] of FINANCIAL_TABLES) {
    if (opts.excludeTables?.includes(t)) continue;
    const rows = await q.query<any>(`SELECT * FROM ${t} ORDER BY ${order}`);
    tables[t] = { rows: rows.length, hash: sha(JSON.stringify(rows)) };
  }
  const accountBalances: Record<string, number> = {};
  for (const a of await q.query<any>(
    `SELECT a.code, a.type,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction='D'),0) AS d,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction='C'),0) AS c
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.code, a.type ORDER BY a.code`,
  )) accountBalances[a.code] = num(a.type === 'ASSET' || a.type === 'EXPENSE' ? a.d - a.c : a.c - a.d);
  const merchantPayables = Object.fromEntries(Object.entries(accountBalances).filter(([k]) => k.endsWith(':PAYABLE')));
  const statusCounts: Snapshot['statusCounts'] = {};
  for (const [t, col] of [['payments', 'status'], ['payouts', 'status'], ['refunds', 'status'], ['payment_requests', 'status'], ['webhook_events', 'status']]) {
    statusCounts[t] = {};
    for (const r of await q.query<any>(`SELECT ${col} AS s, COUNT(*) AS n FROM ${t} GROUP BY ${col} ORDER BY ${col}`)) statusCounts[t][r.s] = num(r.n);
  }
  const queue: Record<string, number> = {};
  for (const r of await q.query<any>(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status ORDER BY status`)) queue[r.status] = num(r.n);
  return { digest: sha(JSON.stringify({ tables, accountBalances, statusCounts })), tables, accountBalances, merchantPayables, statusCounts, queue };
}

export function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    if (a.tables[t]?.hash !== b.tables[t]?.hash) out.push(`table ${t}: ${a.tables[t]?.rows} rows/${a.tables[t]?.hash?.slice(0, 8)} vs ${b.tables[t]?.rows} rows/${b.tables[t]?.hash?.slice(0, 8)}`);
  }
  if (JSON.stringify(a.accountBalances) !== JSON.stringify(b.accountBalances)) out.push('account balances differ');
  return out;
}

/** Structure fingerprint (columns, indexes, constraints, user triggers) used to prove constraints survived a restore. */
export async function schemaFingerprint(q: Queryable): Promise<{ digest: string; items: string[] }> {
  const items: string[] = [];
  for (const r of await q.query<any>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name, column_name`,
  )) items.push(`col:${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}:${r.column_default ?? ''}`);
  for (const r of await q.query<any>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`)) items.push(`idx:${r.indexname}:${r.indexdef}`);
  for (const r of await q.query<any>(
    `SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text, conname`,
  )) items.push(`con:${r.t}:${r.conname}:${r.def}`);
  for (const r of await q.query<any>(
    `SELECT tgrelid::regclass::text AS t, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgrelid::regclass::text, tgname`,
  )) items.push(`trg:${r.t}:${r.tgname}:${r.def}`);
  return { digest: sha(items.join('\n')), items };
}

const REQUIRED_STRUCTURES = {
  triggers: ['ledger_entries_immutable', 'ledger_journals_immutable', 'ledger_entries_balanced', 'audit_logs_immutable'],
  indexesOrConstraints: [
    'payments_provider_provider_payment_id_key',
    'webhook_events_provider_provider_event_id_key',
    'payouts_merchant_id_idempotency_key_key',
    'ledger_journals_kind_ref_type_ref_id_key',
    'payment_requests_provider_order_id_key',
    'refunds_payment_id_idempotency_key_key',
    'one_verified_destination',
    'payouts_provider_ref',
  ],
};

/**
 * Verifies financial invariants from first principles (not row counts). Read-only.
 * `expectedSchemaDigest` (optional) additionally proves the restored structure equals a freshly migrated one.
 */
export async function verifyFinancialIntegrity(q: Queryable, opts: { expectedSchemaDigest?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: ok ? undefined : detail });
  const rows = <T = any>(sql: string, p: unknown[] = []) => q.query<T>(sql, p);

  // 1. Ledger structure
  const unbalanced = await new LedgerService().findUnbalancedJournals(q);
  add('every journal balances (debits = credits)', unbalanced.length === 0, unbalanced);
  const thin = await rows(`SELECT j.id FROM ledger_journals j LEFT JOIN ledger_entries e ON e.journal_id=j.id GROUP BY j.id HAVING COUNT(e.id) < 2`);
  add('every journal has at least two entries (no vanished entries)', thin.length === 0, thin);
  const [tb] = await rows<any>(`SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction='D'),0) d, COALESCE(SUM(amount_minor) FILTER (WHERE direction='C'),0) c FROM ledger_entries`);
  add('trial balance: total debits = total credits', num(tb.d) === num(tb.c), tb);

  // 2. Accounting equation: provider clearing (asset) = merchant payables + payout clearing + suspense + fee revenue
  const [eq] = await rows<any>(
    `SELECT COALESCE(SUM(CASE WHEN a.type='ASSET' THEN (CASE e.direction WHEN 'D' THEN e.amount_minor ELSE -e.amount_minor END) ELSE 0 END),0) AS assets,
            COALESCE(SUM(CASE WHEN a.type IN ('LIABILITY','REVENUE') THEN (CASE e.direction WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END) ELSE 0 END),0) AS claims
       FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id`,
  );
  add('assets = liabilities + revenue (accounting equation)', num(eq.assets) === num(eq.claims), eq);

  // 3. Merchant payable (ledger) == independently derived from business tables
  const derived = await rows<any>(
    `SELECT m.id AS merchant_id,
       COALESCE((SELECT SUM(net_minor) FROM payments p WHERE p.merchant_id=m.id AND p.status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED')),0)
     - COALESCE((SELECT SUM(r.amount_minor - r.fee_refund_minor) FROM refunds r JOIN payments p ON p.id=r.payment_id
                  WHERE r.merchant_id=m.id AND r.status='SUCCEEDED' AND p.net_minor > 0),0)  -- refunds out of suspense never touched the payable
     - COALESCE((SELECT SUM(amount_minor) FROM payouts po WHERE po.merchant_id=m.id AND po.status IN ('QUEUED','SUBMITTED','PROCESSING','UNDER_REVIEW','SUCCEEDED')),0) AS expected
       FROM merchants m`,
  );
  const ledgerPay = await rows<any>(
    `SELECT a.merchant_id, COALESCE(SUM(CASE e.direction WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END),0) AS bal
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.code LIKE 'MERCHANT:%:PAYABLE' GROUP BY a.merchant_id`,
  );
  const ledgerBy = new Map(ledgerPay.map((r) => [r.merchant_id, num(r.bal)]));
  const balMismatch = derived.filter((d) => num(d.expected) !== (ledgerBy.get(d.merchant_id) ?? 0)).map((d) => ({ merchant: d.merchant_id, derived: num(d.expected), ledger: ledgerBy.get(d.merchant_id) ?? 0 }));
  add('merchant payable balances reconcile with business records (payments, refunds, payouts)', balMismatch.length === 0, balMismatch);

  // 4. Payments
  const dupPay = await rows(`SELECT provider, provider_payment_id FROM payments GROUP BY 1,2 HAVING COUNT(*) > 1`);
  const dupOrd = await rows(`SELECT provider_order_id FROM payment_requests WHERE provider_order_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1`);
  add('payment ids and provider references are unique', dupPay.length === 0 && dupOrd.length === 0, { dupPay, dupOrd });
  const noJournal = await rows(
    `SELECT p.id, p.status FROM payments p WHERE
       (p.status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED') AND p.merchant_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_journals j WHERE j.ref_type='payment' AND j.ref_id=p.id::text AND j.kind IN ('COLLECTION','SUSPENSE_RELEASE')))
    OR (p.status = 'UNDER_REVIEW' AND NOT EXISTS (SELECT 1 FROM ledger_journals j WHERE j.ref_type='payment' AND j.ref_id=p.id::text AND j.kind='SUSPENSE_IN'))`,
  );
  add('every settled payment has its ledger journal (no payment without ledger entries)', noJournal.length === 0, noJournal);
  const orphanJournal = await rows(`SELECT j.id FROM ledger_journals j WHERE j.kind IN ('COLLECTION','SUSPENSE_IN') AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id::text=j.ref_id)`);
  add('every collection journal belongs to an existing payment', orphanJournal.length === 0, orphanJournal);

  // 5. Payouts: reservation / completion / release consistency
  const badPayout = await rows<any>(
    `SELECT po.id, po.status,
        EXISTS (SELECT 1 FROM ledger_journals j WHERE j.ref_type='payout' AND j.ref_id=po.id::text AND j.kind='PAYOUT_RESERVE') AS reserve,
        EXISTS (SELECT 1 FROM ledger_journals j WHERE j.ref_type='payout' AND j.ref_id=po.id::text AND j.kind='PAYOUT_COMPLETE') AS complete,
        EXISTS (SELECT 1 FROM ledger_journals j WHERE j.ref_type='payout' AND j.ref_id=po.id::text AND j.kind='PAYOUT_RELEASE') AS release,
        EXISTS (SELECT 1 FROM ledger_journals j WHERE j.ref_type='payout' AND j.ref_id=po.id::text AND j.kind='PAYOUT_RETURN') AS ret
       FROM payouts po`,
  );
  const inflight = ['QUEUED', 'SUBMITTED', 'PROCESSING', 'UNDER_REVIEW'];
  const wrong = badPayout.filter((p) => {
    if (!p.reserve) return true;
    if (inflight.includes(p.status)) return p.complete || p.release || p.ret;
    if (p.status === 'SUCCEEDED') return !p.complete || p.release || p.ret;
    if (p.status === 'FAILED') return !p.release || p.complete || p.ret;
    if (p.status === 'RETURNED') return !p.complete || !p.ret || p.release;
    return true;
  });
  add('payout reservations, completions and releases are consistent with payout status', wrong.length === 0, wrong);
  const [pc] = await rows<any>(
    `SELECT COALESCE(SUM(CASE e.direction WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END),0) AS bal
       FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code=$1`,
    [ACCOUNTS.PAYOUT_CLEARING.code],
  );
  const [inf] = await rows<any>(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM payouts WHERE status IN ('QUEUED','SUBMITTED','PROCESSING','UNDER_REVIEW')`);
  add('payout-clearing balance equals the sum of in-flight payouts (available balances are consistent)', num(pc.bal) === num(inf.s), { ledger: num(pc.bal), inflight: num(inf.s) });
  const reserveAmt = await rows(
    `SELECT po.id FROM payouts po JOIN ledger_journals j ON j.ref_type='payout' AND j.ref_id=po.id::text AND j.kind='PAYOUT_RESERVE'
      WHERE (SELECT COALESCE(SUM(amount_minor),0) FROM ledger_entries e WHERE e.journal_id=j.id AND e.direction='D') <> po.amount_minor`,
  );
  add('each payout reservation journal equals the payout amount', reserveAmt.length === 0, reserveAmt);

  // 6. Refunds
  const refundBad = await rows<any>(
    `SELECT r.id, r.status FROM refunds r WHERE
        (r.status='SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM ledger_journals j WHERE j.kind='REFUND' AND j.ref_type='refund' AND j.ref_id=r.id::text))
     OR (r.status <> 'SUCCEEDED' AND EXISTS (SELECT 1 FROM ledger_journals j WHERE j.kind='REFUND' AND j.ref_type='refund' AND j.ref_id=r.id::text))`,
  );
  add('refund journals exist exactly for succeeded refunds (compensating entries intact)', refundBad.length === 0, refundBad);
  const refundSum = await rows<any>(
    `SELECT p.id, p.refunded_minor, COALESCE(SUM(r.amount_minor) FILTER (WHERE r.status='SUCCEEDED'),0) AS s FROM payments p LEFT JOIN refunds r ON r.payment_id=p.id GROUP BY p.id, p.refunded_minor
     HAVING p.refunded_minor <> COALESCE(SUM(r.amount_minor) FILTER (WHERE r.status='SUCCEEDED'),0)`,
  );
  add('payments.refunded_minor equals the sum of succeeded refunds', refundSum.length === 0, refundSum);

  // 7. Idempotency & webhook de-duplication keys
  const dupKeys = await rows(
    `SELECT 'payout' k FROM payouts GROUP BY merchant_id, idempotency_key HAVING COUNT(*)>1
     UNION ALL SELECT 'refund' FROM refunds GROUP BY payment_id, idempotency_key HAVING COUNT(*)>1
     UNION ALL SELECT 'webhook' FROM webhook_events GROUP BY provider, provider_event_id HAVING COUNT(*)>1
     UNION ALL SELECT 'journal' FROM ledger_journals GROUP BY kind, ref_type, ref_id HAVING COUNT(*)>1`,
  );
  add('idempotency / de-duplication keys are unique (payouts, refunds, webhooks, journals)', dupKeys.length === 0, dupKeys);
  const unapplied = await rows(
    `SELECT w.id FROM webhook_events w WHERE w.status='PROCESSED' AND w.event_type LIKE 'payment.%'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.provider_payment_id = (w.payload::jsonb ->> 'paymentId'))`,
  );
  add('every PROCESSED payment webhook corresponds to a recorded payment', unapplied.length === 0, unapplied);

  // 8. Structure
  const trg = (await rows<any>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).map((r) => r.tgname);
  const idx = new Set([
    ...(await rows<any>(`SELECT indexname AS n FROM pg_indexes WHERE schemaname='public'`)).map((r) => r.n),
    ...(await rows<any>(`SELECT conname AS n FROM pg_constraint WHERE connamespace='public'::regnamespace`)).map((r) => r.n),
  ]);
  const missingTrg = REQUIRED_STRUCTURES.triggers.filter((t) => !trg.includes(t));
  const missingIdx = REQUIRED_STRUCTURES.indexesOrConstraints.filter((i) => !idx.has(i));
  add('ledger/audit immutability triggers and uniqueness constraints are present', missingTrg.length + missingIdx.length === 0, { missingTrg, missingIdx });
  if (opts.expectedSchemaDigest) {
    const fp = await schemaFingerprint(q);
    add('schema (columns, indexes, constraints, triggers) equals a freshly migrated schema', fp.digest === opts.expectedSchemaDigest, { got: fp.digest });
  }
  const applied = (await rows<any>('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
  const known = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const unknown = applied.filter((a) => !known.includes(a));
  add('migration history contains no unknown (newer) migrations', unknown.length === 0, { unknown, note: 'backup is from a newer application version' });

  // 9. Audit chain
  add('audit hash chain verifies', await new AuditService().verifyChain(q));
  return checks;
}

export function summarize(checks: Check[]) {
  const failed = checks.filter((c) => !c.ok);
  return { total: checks.length, failed: failed.length, ok: failed.length === 0, failures: failed };
}

export async function assertIntegrity(q: Queryable, opts: { expectedSchemaDigest?: string } = {}) {
  const s = summarize(await verifyFinancialIntegrity(q, opts));
  if (!s.ok) throw new Error('Financial integrity checks failed: ' + JSON.stringify(s.failures, null, 2));
  return s;
}
