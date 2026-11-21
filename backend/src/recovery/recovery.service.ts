import { DomainError, TransientError } from '../common/errors';
import { Db, Queryable } from '../db/db';
import { Actor, AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PayoutsService } from '../payouts/payouts.service';
import { VerificationService } from '../payments/verification.service';
import { PaymentProvider } from '../provider/provider';
import { ACCOUNTS, LedgerService, merchantPayable } from '../ledger/ledger.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { DB_FINGERPRINT, getFlag, MONEY_OUT_FROZEN, setFlag } from './flags';

const REVIEW_REASON = 'RESTORE_UNKNOWN_OUTCOME';

/**
 * Safe handling of a database restore or failover.
 *
 * A restored database can be OLDER than reality: payouts/refunds may have reached the provider after the
 * backup point, so balances look higher than they are and "queued" work may already have been done.
 * Therefore, until provider reconciliation is clean and a human releases it:
 *   - no new payouts or refunds may be requested, and none may be submitted to the provider (money-out freeze)
 *   - in-flight payouts are resolved from the provider's records or held for explicit review
 *   - every login session is revoked (revocations made after the backup point would otherwise be undone)
 * Inbound processing (webhooks, payment verification) stays on: it is idempotent and only adds truth.
 */
export class RecoveryService {
  constructor(
    private readonly db: Db,
    private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly payouts: PayoutsService,
    private readonly verification: VerificationService,
    private readonly reconciliation: ReconciliationService,
    private readonly ledger: LedgerService,
  ) {}

  private now() {
    return this.auth.now();
  }

  /** Identity of this database incarnation. A restore or failover changes it (new timeline / system id). */
  async fingerprint(q: Queryable = this.db): Promise<string> {
    try {
      const [s] = await q.query<any>('SELECT system_identifier::text AS sid FROM pg_control_system()');
      const [c] = await q.query<any>('SELECT timeline_id AS tl FROM pg_control_checkpoint()');
      return `${s.sid}:${c.tl}`;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Call on every application start. If the database incarnation differs from the one that last ran the app
   * (restore from backup, PITR, failover, clone), money-out is frozen automatically.
   */
  async startupCheck(): Promise<{ changed: boolean; frozen: boolean }> {
    const current = await this.fingerprint();
    const stored = await getFlag(this.db, DB_FINGERPRINT);
    let changed = false;
    await this.db.transaction(async (tx) => {
      if (stored && stored.value !== current && current !== 'unknown') {
        changed = true;
        await this.freezeTx(tx, { id: null, role: 'SYSTEM' }, `database incarnation changed (${stored.value} -> ${current}): restore, PITR or failover suspected`);
      }
      if (!stored || changed) await setFlag(tx, DB_FINGERPRINT, current, 'recorded at startup', null, this.now());
    });
    return { changed, frozen: (await getFlag(this.db, MONEY_OUT_FROZEN))?.value === 'true' };
  }

  async status() {
    const f = await getFlag(this.db, MONEY_OUT_FROZEN);
    const [inflight] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM payouts WHERE status IN ('SUBMITTED','PROCESSING')`);
    const [held] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM risk_reviews WHERE reason=$1 AND status='OPEN'`, [REVIEW_REASON]);
    const [queued] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM payouts WHERE status='QUEUED'`);
    const [refunds] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM refunds WHERE status='PENDING'`);
    return {
      moneyOutFrozen: f?.value === 'true',
      frozenSince: f?.value === 'true' ? f.set_at : null,
      reason: f?.value === 'true' ? f.reason : null,
      payoutsInFlight: Number(inflight.n),
      payoutsHeldForReview: Number(held.n),
      payoutsQueued: Number(queued.n),
      refundsPending: Number(refunds.n),
    };
  }

  private async freezeTx(tx: Queryable, actor: Actor, reason: string) {
    const cur = await getFlag(tx, MONEY_OUT_FROZEN);
    if (cur?.value === 'true') return false;
    await setFlag(tx, MONEY_OUT_FROZEN, 'true', reason, actor.id, this.now());
    await this.audit.record(tx, actor, 'recovery.money_out.frozen', 'system', 'money_out', { reason });
    await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('MONEY_OUT_FROZEN', $1)`, [JSON.stringify({ reason })]);
    return true;
  }

  async freeze(actor: Actor, reason: string) {
    return this.db.transaction((tx) => this.freezeTx(tx, actor, reason));
  }

  /**
   * Run (by the operator, as a CLI step, immediately after restoring and BEFORE serving traffic) on a restored database.
   * Idempotent: running it again changes nothing that is already resolved and never submits anything to the provider.
   */
  async postRestore(actor: Actor) {
    const now = this.now();
    await this.freeze(actor, 'post-restore procedure');

    const sessionsRevoked = (
      await this.db.query<{ id: string }>(`UPDATE auth_sessions SET revoked_at=$1, revoked_reason='post_restore' WHERE revoked_at IS NULL RETURNING id`, [now])
    ).length;

    // Inbound only: payments the provider captured after the backup point are applied through the normal, idempotent path.
    let paymentsRecovered = 0;
    let paymentErrors = 0;
    // A provider with no transaction-report API (PhonePe, Paytm) cannot be swept: its payments arrive through webhooks/status lookups only.
    const remote = await this.provider.listPayments().catch((e) => {
      if (e instanceof DomainError && e.code === 'CAPABILITY_UNAVAILABLE') return [];
      throw e;
    });
    for (const pp of remote) {
      if (pp.status !== 'captured') continue;
      const [known] = await this.db.query('SELECT 1 FROM payments WHERE provider=$1 AND provider_payment_id=$2', [this.provider.name, pp.id]);
      if (known) continue;
      try {
        await this.verification.applyProviderPayment(pp);
        paymentsRecovered++;
      } catch {
        paymentErrors++;
      }
    }

    // In-flight payouts: provider's record is the truth (read-only lookup); anything undetermined is held, funds stay reserved.
    let payoutsSynced = 0;
    let payoutsHeld = 0;
    const inflight = await this.db.query<{ id: string }>(`SELECT id FROM payouts WHERE status IN ('SUBMITTED','PROCESSING') ORDER BY created_at`);
    for (const { id } of inflight) {
      let remote = null;
      let unavailable = false;
      try {
        remote = await this.provider.getPayoutByReference(id);
      } catch (e) {
        if (!(e instanceof TransientError)) throw e;
        unavailable = true;
      }
      if (remote && !unavailable) {
        await this.payouts.applyProviderPayout(id, remote);
        payoutsSynced++;
      } else {
        if (await this.holdForReview(id, actor, unavailable ? 'provider unreachable' : 'provider has no record of this payout reference')) payoutsHeld++;
      }
    }

    const recon = await this.reconciliation.run();
    const [q] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM payouts WHERE status='QUEUED'`);
    const [r] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM refunds WHERE status='PENDING'`);
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, actor, 'recovery.post_restore.completed', 'system', 'restore', { sessionsRevoked, paymentsRecovered, payoutsSynced, payoutsHeld, discrepancies: recon.discrepancies });
      await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('POST_RESTORE_COMPLETED', $1)`, [JSON.stringify({ discrepancies: recon.discrepancies, payoutsHeld })]);
    });
    return {
      moneyOutFrozen: true,
      sessionsRevoked,
      paymentsRecovered,
      paymentErrors,
      payoutsSynced,
      payoutsHeldForReview: payoutsHeld,
      payoutsQueuedNotSubmitted: Number(q.n),
      refundsPendingNotSubmitted: Number(r.n),
      reconciliationDiscrepancies: recon.discrepancies,
      reconciliationItems: recon.items.filter((i) => !i.resolved).map((i) => ({ kind: i.kind, subject: i.subject })),
    };
  }

  private async holdForReview(payoutId: string, actor: Actor, why: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.query<any>('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId]);
      if (!p || !['SUBMITTED', 'PROCESSING'].includes(p.status)) return false;
      await tx.query(`UPDATE payouts SET status='UNDER_REVIEW', outcome_unknown=true, updated_at=now() WHERE id=$1`, [payoutId]);
      await tx.query('INSERT INTO payout_events(payout_id, from_status, to_status, detail) VALUES ($1,$2,$3,$4)', [payoutId, p.status, 'UNDER_REVIEW', JSON.stringify({ reason: REVIEW_REASON, why })]);
      await tx.query(`INSERT INTO risk_reviews(subject_type, subject_id, reason, detail) VALUES ('payout',$1,$2,$3)`, [payoutId, REVIEW_REASON, JSON.stringify({ why })]);
      await this.audit.record(tx, actor, 'recovery.payout.held', 'payout', payoutId, { why });
      return true;
    });
  }

  /**
   * Resolves a payout held after a restore, only from provider evidence:
   *  - sync: the provider has the payout -> adopt its state (never resubmits)
   *  - confirmed_not_sent: the provider has NO record AND an administrator attests (note) that the statement/dashboard
   *    shows no transfer -> payout is re-queued; it still cannot be submitted until the freeze is lifted, and submission
   *    again looks the payout up first and uses the same idempotency key.
   */
  async resolveHeldPayout(actor: Actor, payoutId: string, outcome: 'sync' | 'confirmed_not_sent', note: string) {
    const [p] = await this.db.query<any>('SELECT * FROM payouts WHERE id=$1', [payoutId]);
    if (!p) throw new DomainError('NOT_FOUND', 'Payout not found', 404);
    const [review] = await this.db.query<any>(`SELECT id FROM risk_reviews WHERE subject_type='payout' AND subject_id=$1 AND reason=$2 AND status='OPEN'`, [payoutId, REVIEW_REASON]);
    if (p.status !== 'UNDER_REVIEW' || !review) throw new DomainError('NOT_HELD_BY_RESTORE', 'Payout is not held by the post-restore procedure', 409);

    let remote;
    try {
      remote = await this.provider.getPayoutByReference(payoutId);
    } catch (e) {
      if (e instanceof TransientError) throw new DomainError('PROVIDER_UNAVAILABLE', 'Provider lookup failed; cannot resolve without provider evidence', 503);
      throw e;
    }
    if (outcome === 'sync') {
      if (!remote) throw new DomainError('NOT_AT_PROVIDER', 'Provider has no record of this payout; use confirmed_not_sent after checking statements', 409);
      await this.db.query(`UPDATE payouts SET status='SUBMITTED' WHERE id=$1 AND status='UNDER_REVIEW'`, [payoutId]);
      await this.payouts.applyProviderPayout(payoutId, remote);
    } else {
      if (remote) throw new DomainError('EXISTS_AT_PROVIDER', 'Provider has this payout; use sync', 409);
      if (note.trim().length < 10) throw new DomainError('NOTE_REQUIRED', 'Describe the statement/dashboard check that shows no transfer (min 10 chars)');
      await this.payouts.retryUnknown(payoutId, actor);
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE risk_reviews SET status='APPROVED', decided_by=$2, decided_at=now() WHERE id=$1`, [review.id, actor.id]);
      await this.audit.record(tx, actor, 'recovery.payout.resolved', 'payout', payoutId, { outcome, note: outcome === 'confirmed_not_sent' ? note : undefined });
    });
  }

  // ------------------------------------------------------------------ adopting provider payouts the restored database never recorded
  /**
   * A provider payout with no local record (the backup is older than the payout) leaves the merchant's balance overstated.
   * Adoption records it, under DUAL CONTROL (a second administrator applies it), using the PROVIDER's evidence for the amount and
   * status: an administrator cannot type an amount. It posts the same reserve/complete journals a normal payout would.
   */
  async proposeAdoption(actor: Actor, providerPayoutId: string, merchantId: string, note: string) {
    if (!actor.id) throw new DomainError('ACTOR_REQUIRED', 'An administrator identity is required', 403);
    if (note.trim().length < 10) throw new DomainError('NOTE_REQUIRED', 'Explain how this payout was matched to the merchant (min 10 chars)');
    const remote = await this.findProviderPayout(providerPayoutId);
    if (!remote) throw new DomainError('NOT_AT_PROVIDER', 'The provider has no payout with this id', 404);
    if (!['processed', 'processing'].includes(remote.status)) throw new DomainError('NOTHING_TO_ADOPT', `Provider status is ${remote.status}: no money left the account`, 409);
    const [known] = await this.db.query('SELECT 1 FROM payouts WHERE provider_payout_id=$1 OR id::text=$2', [remote.id, remote.referenceId]);
    if (known) throw new DomainError('ALREADY_RECORDED', 'This payout is already recorded locally', 409);
    const [m] = await this.db.query<any>('SELECT id FROM merchants WHERE id=$1', [merchantId]);
    if (!m) throw new DomainError('NOT_FOUND', 'Merchant not found', 404);
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO recovery_adoptions(provider, provider_payout_id, merchant_id, note, proposed_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [this.provider.name, remote.id, merchantId, note, actor.id],
      );
      if (!rows.length) throw new DomainError('ALREADY_PROPOSED', 'An adoption for this payout already exists', 409);
      await this.audit.record(tx, actor, 'recovery.adoption.proposed', 'payout', remote.id, { adoptionId: rows[0].id, merchantId, amountMinor: remote.amountMinor });
      return { id: rows[0].id, providerPayoutId: remote.id, amountMinor: remote.amountMinor, providerStatus: remote.status };
    });
  }

  async decideAdoption(actor: Actor, adoptionId: string, decision: 'APPLY' | 'REJECT') {
    return this.db.transaction(async (tx) => {
      const [a] = await tx.query<any>('SELECT * FROM recovery_adoptions WHERE id=$1 FOR UPDATE', [adoptionId]);
      if (!a) throw new DomainError('NOT_FOUND', 'Adoption not found', 404);
      if (a.status !== 'PROPOSED') throw new DomainError('ALREADY_DECIDED', `Adoption is ${a.status}`, 409);
      if (a.proposed_by === actor.id) throw new DomainError('DUAL_APPROVAL_REQUIRED', 'A different administrator must decide this adoption', 403);
      if (decision === 'REJECT') {
        await tx.query(`UPDATE recovery_adoptions SET status='REJECTED', decided_by=$2, decided_at=now() WHERE id=$1`, [adoptionId, actor.id]);
        await this.audit.record(tx, actor, 'recovery.adoption.rejected', 'payout', a.provider_payout_id, { adoptionId });
        return { applied: false };
      }
      const remote = await this.findProviderPayout(a.provider_payout_id); // evidence is re-read at application time
      if (!remote || !['processed', 'processing'].includes(remote.status)) throw new DomainError('PROVIDER_STATE_CHANGED', 'Provider no longer shows money leaving the account; re-assess', 409);
      const [known] = await tx.query('SELECT 1 FROM payouts WHERE provider_payout_id=$1 OR id::text=$2', [remote.id, remote.referenceId]);
      if (known) throw new DomainError('ALREADY_RECORDED', 'This payout is already recorded locally', 409);
      const [dest] = await tx.query<any>(`SELECT id FROM merchant_settlement_destinations WHERE merchant_id=$1 ORDER BY (status='VERIFIED') DESC, created_at DESC LIMIT 1`, [a.merchant_id]);
      if (!dest) throw new DomainError('NO_DESTINATION', 'Merchant has no settlement destination record to attach this payout to', 409);
      const status = remote.status === 'processed' ? 'SUCCEEDED' : 'PROCESSING';
      const [p] = await tx.query<any>(
        `INSERT INTO payouts(merchant_id, destination_id, amount_minor, currency, status, idempotency_key, provider, provider_payout_id, requested_by, approved_by, is_sandbox)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [a.merchant_id, dest.id, remote.amountMinor, remote.currency, status, `adopted:${adoptionId}`, this.provider.name, remote.id, a.proposed_by, actor.id, this.provider.isSandbox],
      );
      await this.ledger.post(tx, {
        kind: 'PAYOUT_RESERVE', refType: 'payout', refId: p.id, currency: remote.currency, sandbox: this.provider.isSandbox,
        lines: [
          { account: merchantPayable(a.merchant_id), dir: 'D', amountMinor: remote.amountMinor },
          { account: ACCOUNTS.PAYOUT_CLEARING.code, dir: 'C', amountMinor: remote.amountMinor },
        ],
      });
      if (status === 'SUCCEEDED') {
        await this.ledger.post(tx, {
          kind: 'PAYOUT_COMPLETE', refType: 'payout', refId: p.id, currency: remote.currency, sandbox: this.provider.isSandbox,
          lines: [
            { account: ACCOUNTS.PAYOUT_CLEARING.code, dir: 'D', amountMinor: remote.amountMinor },
            { account: ACCOUNTS.PROVIDER_CLEARING.code, dir: 'C', amountMinor: remote.amountMinor },
          ],
        });
      }
      await tx.query('INSERT INTO payout_events(payout_id, from_status, to_status, detail) VALUES ($1,NULL,$2,$3)', [p.id, status, JSON.stringify({ adoptedFromProvider: remote.id, adoptionId })]);
      await tx.query(`UPDATE recovery_adoptions SET status='APPLIED', decided_by=$2, decided_at=now(), payout_id=$3 WHERE id=$1`, [adoptionId, actor.id, p.id]);
      await this.audit.record(tx, actor, 'recovery.adoption.applied', 'payout', p.id, { adoptionId, providerPayoutId: remote.id, amountMinor: remote.amountMinor, status });
      return { applied: true, payoutId: p.id, amountMinor: remote.amountMinor, status };
    });
  }

  listAdoptions() {
    return this.db.query('SELECT id, provider_payout_id, merchant_id, status, note, proposed_by, decided_by, payout_id, created_at, decided_at FROM recovery_adoptions ORDER BY created_at DESC LIMIT 100');
  }

  private async findProviderPayout(providerPayoutId: string) {
    return (await this.provider.listPayouts()).find((x) => x.id === providerPayoutId) ?? null;
  }

  /** Lifts the freeze only if a FRESH reconciliation is clean and nothing is left undetermined. */
  async unfreeze(actor: Actor) {
    const f = await getFlag(this.db, MONEY_OUT_FROZEN);
    if (f?.value !== 'true') throw new DomainError('NOT_FROZEN', 'Money-out is not frozen', 409);
    const st = await this.status();
    if (st.payoutsInFlight > 0 || st.payoutsHeldForReview > 0) {
      throw new DomainError('UNRESOLVED_PAYOUTS', `${st.payoutsInFlight} in flight, ${st.payoutsHeldForReview} held: resolve from provider evidence first`, 409);
    }
    const run = await this.reconciliation.run();
    if (run.discrepancies > 0) {
      throw new DomainError('RECONCILIATION_NOT_CLEAN', `Reconciliation has ${run.discrepancies} open discrepancies: ${[...new Set(run.items.filter((i) => !i.resolved).map((i) => i.kind))].join(', ')}`, 409);
    }
    await this.db.transaction(async (tx) => {
      await setFlag(tx, MONEY_OUT_FROZEN, 'false', `released by administrator after clean reconciliation ${run.runId}`, actor.id, this.now());
      await this.audit.record(tx, actor, 'recovery.money_out.unfrozen', 'system', 'money_out', { reconciliationRun: run.runId });
    });
    return { unfrozen: true, reconciliationRun: run.runId };
  }
}
