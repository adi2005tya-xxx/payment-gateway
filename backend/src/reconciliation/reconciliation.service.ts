import { Db } from '../db/db';
import { ACCOUNTS, LedgerService } from '../ledger/ledger.service';
import { PayoutsService } from '../payouts/payouts.service';
import { PaymentProvider } from '../provider/provider';

interface Item {
  kind: string;
  subject: string;
  detail: Record<string, unknown>;
  resolved?: boolean;
}

/**
 * Compares our ledger/records against the provider's records. The provider's webhook and status API are
 * not independent of each other, so this (and ultimately bank/settlement statements) is the backstop.
 */
export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
  ) {}

  async run() {
    const items: Item[] = [];
    let checked = 0;

    const remotePayments = await this.provider.listPayments();
    const remoteIds = new Set<string>();
    let remoteNet = 0;
    for (const rp of remotePayments) {
      checked++;
      remoteIds.add(rp.id);
      const [p] = await this.db.query<any>('SELECT * FROM payments WHERE provider=$1 AND provider_payment_id=$2', [this.provider.name, rp.id]);
      if (rp.status === 'captured' || rp.status === 'refunded') remoteNet += rp.amountMinor - rp.refundedMinor;
      if (!p) {
        if (rp.status === 'captured' || rp.status === 'refunded') items.push({ kind: 'MISSING_INTERNAL_PAYMENT', subject: rp.id, detail: { amountMinor: rp.amountMinor, status: rp.status } });
        continue;
      }
      if (Number(p.amount_minor) !== rp.amountMinor) items.push({ kind: 'AMOUNT_MISMATCH', subject: rp.id, detail: { internal: Number(p.amount_minor), provider: rp.amountMinor } });
      if (p.status === 'SUCCEEDED' && rp.status !== 'captured') items.push({ kind: 'PAYMENT_STATUS_MISMATCH', subject: rp.id, detail: { internal: p.status, provider: rp.status } });
      if (Number(p.refunded_minor) !== rp.refundedMinor) items.push({ kind: 'REFUND_MISMATCH', subject: rp.id, detail: { internal: Number(p.refunded_minor), provider: rp.refundedMinor } });
    }

    const internal = await this.db.query<any>(`SELECT * FROM payments WHERE provider=$1 AND status NOT IN ('FAILED','CREATED','PENDING','EXPIRED')`, [this.provider.name]);
    for (const p of internal) {
      checked++;
      if (!remoteIds.has(p.provider_payment_id)) items.push({ kind: 'MISSING_AT_PROVIDER', subject: p.provider_payment_id, detail: { status: p.status } });
      if (['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) {
        const j = await this.db.query('SELECT 1 FROM ledger_journals WHERE kind=$1 AND ref_type=$2 AND ref_id=$3', ['COLLECTION', 'payment', p.id]);
        const s = await this.db.query('SELECT 1 FROM ledger_journals WHERE kind=$1 AND ref_type=$2 AND ref_id=$3', ['SUSPENSE_RELEASE', 'payment', p.id]);
        if (!j.length && !s.length) items.push({ kind: 'MISSING_LEDGER_ENTRY', subject: p.id, detail: {} });
      }
    }

    // Payouts: heal in-flight / returned ones through the normal (idempotent) path, flag the rest.
    const remotePayouts = await this.provider.listPayouts();
    let remotePaidOut = 0;
    for (const rp of remotePayouts) {
      checked++;
      if (rp.status === 'processed') remotePaidOut += rp.amountMinor;
      const [po] = await this.db.query<any>('SELECT * FROM payouts WHERE id::text=$1 OR provider_payout_id=$2 ORDER BY (id::text=$1) DESC LIMIT 1', [rp.referenceId, rp.id]);
      if (!po) {
        items.push({ kind: 'ORPHAN_PROVIDER_PAYOUT', subject: rp.id, detail: { amountMinor: rp.amountMinor, referenceId: rp.referenceId } });
        continue;
      }
      const wantsSync =
        (po.status === 'QUEUED') ||
        (['SUBMITTED', 'PROCESSING', 'UNDER_REVIEW'].includes(po.status) && rp.status !== 'processing') ||
        (po.status === 'SUCCEEDED' && rp.status === 'reversed');
      if (wantsSync) {
        await this.payouts.applyProviderPayout(po.id, rp);
        items.push({ kind: 'PAYOUT_SYNCED', subject: po.id, detail: { was: po.status, provider: rp.status }, resolved: true });
      } else if (po.status === 'SUCCEEDED' && rp.status !== 'processed') {
        items.push({ kind: 'PAYOUT_STATUS_MISMATCH', subject: po.id, detail: { internal: po.status, provider: rp.status } });
      }
    }
    const stuck = await this.db.query<any>(`SELECT id FROM payouts WHERE status IN ('SUBMITTED','PROCESSING') AND updated_at < now() - interval '1 hour'`);
    for (const s of stuck) items.push({ kind: 'PAYOUT_STUCK', subject: s.id, detail: {} });

    // Ledger integrity.
    for (const u of await this.ledger.findUnbalancedJournals(this.db)) items.push({ kind: 'UNBALANCED_JOURNAL', subject: u.journal_id, detail: { debits: u.d, credits: u.c } });
    const clearing = await this.ledger.balance(this.db, ACCOUNTS.PROVIDER_CLEARING.code);
    if (clearing !== remoteNet - remotePaidOut) {
      items.push({ kind: 'PROVIDER_CLEARING_MISMATCH', subject: ACCOUNTS.PROVIDER_CLEARING.code, detail: { ledger: clearing, providerImplied: remoteNet - remotePaidOut } });
    }

    const open = items.filter((i) => !i.resolved).length;
    return this.db.transaction(async (tx) => {
      const [run] = await tx.query<{ id: string }>(
        `INSERT INTO reconciliation_runs(provider, items_checked, discrepancies) VALUES ($1,$2,$3) RETURNING id`,
        [this.provider.name, checked, open],
      );
      for (const i of items) {
        await tx.query(`INSERT INTO reconciliation_items(run_id, kind, subject_ref, detail, resolved) VALUES ($1,$2,$3,$4,$5)`, [run.id, i.kind, i.subject, JSON.stringify(i.detail), !!i.resolved]);
      }
      if (open > 0) await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('RECONCILIATION_DISCREPANCY', $1)`, [JSON.stringify({ runId: run.id, discrepancies: open })]);
      return { runId: run.id, checked, discrepancies: open, items };
    });
  }
}
