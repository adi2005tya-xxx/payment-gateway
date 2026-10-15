import { DomainError } from '../common/errors';
import { Db } from '../db/db';
import { Actor, AuditService } from '../audit/audit.service';
import { SecretBox } from '../auth/secretbox';
import { VerificationService } from '../payments/verification.service';
import { AlertIngestService } from './ingest.service';

const REVIEWABLE = ['UNMATCHED', 'AMBIGUOUS', 'REVIEW'];
const minute = 60_000;

/** Human decisions on credits the system would not decide alone. Every action is audited and needs MFA step-up at the API. */
export class CollectionsReviewService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly verification: VerificationService,
    private readonly ingest: AlertIngestService,
    private readonly box: SecretBox,
    private readonly provider: { name: string },
  ) {}

  // ------------------------------------------------------------------ dashboard
  async dashboard() {
    const orders = await this.db.query<any>(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_minor),0) AS amount FROM payment_requests WHERE provider=$1 GROUP BY status`,
      [this.provider.name],
    );
    const by = Object.fromEntries(orders.map((o) => [o.status, { count: o.n, amountMinor: Number(o.amount) }]));
    const zero = { count: 0, amountMinor: 0 };
    const [cr] = await this.db.query<any>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('UNMATCHED','AMBIGUOUS','REVIEW'))::int AS unmatched,
              COUNT(*) FILTER (WHERE status='MATCHED')::int AS matched, COUNT(*) FILTER (WHERE status='DISMISSED')::int AS dismissed,
              COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('UNMATCHED','AMBIGUOUS','REVIEW')),0) AS unmatched_amount FROM bank_credits`,
    );
    return {
      pending: by.PENDING ?? zero,
      paid: by.PAID ?? zero,
      expired: by.EXPIRED ?? zero,
      underReview: by.UNDER_REVIEW ?? zero,
      cancelled: by.CANCELLED ?? zero,
      unmatched: { count: cr.unmatched, amountMinor: Number(cr.unmatched_amount) },
      credits: { matched: cr.matched, dismissed: cr.dismissed },
    };
  }

  async orders(status?: string) {
    return this.db.query(
      `SELECT r.id, r.order_reference, r.provider_order_id AS order_id, r.amount_minor, r.base_amount_minor, r.unique_amount, r.status, r.payee_vpa, r.expires_at, r.created_at, r.public_token, m.display_name AS merchant,
              (SELECT c.reference FROM bank_credits c WHERE c.order_id = r.id AND c.status='MATCHED' LIMIT 1) AS paid_reference,
              (SELECT c.evidence FROM bank_credits c WHERE c.order_id = r.id AND c.status='MATCHED' LIMIT 1) AS paid_evidence
         FROM payment_requests r JOIN merchants m ON m.id=r.merchant_id
        WHERE r.provider=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT 200`,
      [this.provider.name, status ?? null],
    );
  }

  async credits(status?: string) {
    const rows = await this.db.query<any>(
      `SELECT id, reference, amount_minor, credited_at, payer_masked, order_tokens, status, reason, match_method, order_id, payment_id, candidates, evidence, note, created_at
         FROM bank_credits WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT 200`,
      [status ?? null],
    );
    return rows;
  }

  async messages() {
    return this.db.query(`SELECT id, source, received_at, from_addr, subject, status, reason, attempts, processed_at FROM mail_messages ORDER BY created_at DESC LIMIT 200`);
  }

  /** Masked view of an alert for a reviewer: the stored text is decrypted but account-like numbers are masked. */
  async messageText(id: string, actor: Actor) {
    const [m] = await this.db.query<any>('SELECT body_enc FROM mail_messages WHERE id=$1', [id]);
    if (!m?.body_enc) throw new DomainError('NOT_FOUND', 'No stored text for this message', 404);
    await this.db.transaction((tx) => this.audit.record(tx, actor, 'bankmail.message_viewed', 'mail_message', id));
    return { text: this.box.decrypt(m.body_enc, 'mail-body').replace(/\b(\d{2})\d{4,}(\d{2})\b/g, '$1****$2').replace(/([A-Za-z0-9._-]{2})[A-Za-z0-9._-]*@([A-Za-z0-9.-]+)/g, '$1****@$2') };
  }

  // ------------------------------------------------------------------ manual review of an authentic credit
  /**
   * Assigns a credit that came from an authenticated bank alert to an order. The amount must equal the order's exactly (no override),
   * so a reviewer can resolve ambiguity but cannot make a different amount count as payment.
   */
  async assignCredit(actor: Actor, creditId: string, orderId: string, note: string) {
    if (note.trim().length < 10) throw new DomainError('NOTE_REQUIRED', 'Explain why this credit belongs to this order (min 10 chars)');
    const [c] = await this.db.query<any>('SELECT * FROM bank_credits WHERE id=$1', [creditId]);
    if (!c) throw new DomainError('NOT_FOUND', 'Credit not found', 404);
    if (!REVIEWABLE.includes(c.status) || !c.payment_id) throw new DomainError('NOT_REVIEWABLE', `Credit is ${c.status}`, 409);
    if (!['BANK_EMAIL', 'MANUAL_ATTESTATION', 'DEVICE_NOTIFICATION'].includes(c.evidence)) throw new DomainError('NOT_REVIEWABLE', 'Unknown evidence type', 409);
    const [o] = await this.db.query<any>('SELECT * FROM payment_requests WHERE id=$1 AND provider=$2', [orderId, this.provider.name]);
    if (!o) throw new DomainError('NOT_FOUND', 'Order not found', 404);
    if (o.status === 'PAID' || o.status === 'CANCELLED') throw new DomainError('ORDER_NOT_PAYABLE', `Order is ${o.status}`, 409);
    if (Number(o.amount_minor) !== Number(c.amount_minor)) throw new DomainError('AMOUNT_MISMATCH', 'The credit amount must equal the order amount exactly', 409);

    await this.db.query(`UPDATE payments SET payment_request_id=$2, merchant_id=$3, provider_order_id=$4 WHERE id=$1 AND status='UNDER_REVIEW'`, [c.payment_id, o.id, o.merchant_id, o.provider_order_id]);
    try {
      await this.verification.approveReviewedPayment(c.payment_id, actor);
    } catch (e) {
      await this.db.query(`UPDATE payments SET payment_request_id=NULL, merchant_id=NULL, provider_order_id='' WHERE id=$1 AND status='UNDER_REVIEW'`, [c.payment_id]);
      throw e;
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE bank_credits SET status='MATCHED', order_id=$2, match_method='MANUAL_ASSIGN', note=$3, updated_at=now() WHERE id=$1`, [creditId, o.id, note]);
      await this.audit.record(tx, actor, 'bankmail.credit_assigned', 'bank_credit', creditId, { orderId: o.id, note });
    });
  }

  async dismissCredit(actor: Actor, creditId: string, note: string) {
    if (note.trim().length < 10) throw new DomainError('NOTE_REQUIRED', 'Explain why this credit is not for any order (min 10 chars)');
    await this.db.transaction(async (tx) => {
      const [c] = await tx.query<any>('SELECT * FROM bank_credits WHERE id=$1 FOR UPDATE', [creditId]);
      if (!c) throw new DomainError('NOT_FOUND', 'Credit not found', 404);
      if (!REVIEWABLE.includes(c.status)) throw new DomainError('NOT_REVIEWABLE', `Credit is ${c.status}`, 409);
      await tx.query(`UPDATE bank_credits SET status='DISMISSED', note=$2, updated_at=now() WHERE id=$1`, [creditId, note]);
      if (c.payment_id) await tx.query(`UPDATE risk_reviews SET status='REJECTED', decided_by=$2, decided_at=now() WHERE subject_type='payment' AND subject_id=$1 AND status='OPEN'`, [c.payment_id, actor.id]);
      await this.audit.record(tx, actor, 'bankmail.credit_dismissed', 'bank_credit', creditId, { note });
    });
  }

  // ------------------------------------------------------------------ missing alert: dual-controlled, labelled manual attestation
  /**
   * For a payment whose alert never came (or cannot be authenticated). Administrator A records the bank transaction reference and time
   * from the bank statement; administrator B approves. The result is marked MANUAL_ATTESTED everywhere: it is human attestation, not
   * bank-email evidence, and is shown separately on the dashboard.
   */
  async proposeAttestation(actor: Actor, orderId: string, reference: string, creditedAt: Date, note: string) {
    if (!actor.id) throw new DomainError('ACTOR_REQUIRED', 'An administrator identity is required', 403);
    if (note.trim().length < 10) throw new DomainError('NOTE_REQUIRED', 'Say which bank statement line this is (min 10 chars)');
    if (!/^[A-Za-z0-9/_-]{6,64}$/.test(reference)) throw new DomainError('BAD_REFERENCE', 'Enter the bank transaction reference exactly as on the statement');
    const [o] = await this.db.query<any>('SELECT * FROM payment_requests WHERE id=$1 AND provider=$2', [orderId, this.provider.name]);
    if (!o) throw new DomainError('NOT_FOUND', 'Order not found', 404);
    if (!['PENDING', 'EXPIRED'].includes(o.status)) throw new DomainError('ORDER_NOT_PAYABLE', `Order is ${o.status}`, 409);
    if (creditedAt.getTime() > Date.now() + 5 * minute) throw new DomainError('BAD_TIME', 'The credit time cannot be in the future', 400);
    if (creditedAt.getTime() < new Date(o.created_at).getTime() - 2 * minute) throw new DomainError('BAD_TIME', 'The credit is older than the order', 400);
    const [dup] = await this.db.query('SELECT 1 FROM bank_credits WHERE reference=$1', [reference]);
    if (dup) throw new DomainError('REFERENCE_ALREADY_RECORDED', 'This bank reference is already recorded', 409);
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO manual_attestations(order_id, reference, credited_at, note, proposed_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [orderId, reference, creditedAt.toISOString(), note, actor.id],
      );
      if (!rows.length) throw new DomainError('ALREADY_PROPOSED', 'An attestation for this order is already waiting for approval', 409);
      await this.audit.record(tx, actor, 'bankmail.attestation_proposed', 'payment_request', orderId, { attestationId: rows[0].id, reference });
      return { id: rows[0].id };
    });
  }

  async attestations() {
    return this.db.query(`SELECT a.id, a.order_id, r.order_reference, r.amount_minor, a.reference, a.credited_at, a.note, a.status, a.proposed_by, a.created_at FROM manual_attestations a JOIN payment_requests r ON r.id=a.order_id ORDER BY a.created_at DESC LIMIT 100`);
  }

  async decideAttestation(actor: Actor, id: string, decision: 'APPLY' | 'REJECT') {
    const [a] = await this.db.query<any>('SELECT * FROM manual_attestations WHERE id=$1', [id]);
    if (!a) throw new DomainError('NOT_FOUND', 'Attestation not found', 404);
    if (a.status !== 'PROPOSED') throw new DomainError('ALREADY_DECIDED', `Attestation is ${a.status}`, 409);
    if (a.proposed_by === actor.id) throw new DomainError('DUAL_APPROVAL_REQUIRED', 'A different administrator must decide this', 403);
    if (decision === 'REJECT') {
      await this.db.transaction(async (tx) => {
        await tx.query(`UPDATE manual_attestations SET status='REJECTED', decided_by=$2, decided_at=now() WHERE id=$1`, [id, actor.id]);
        await this.audit.record(tx, actor, 'bankmail.attestation_rejected', 'payment_request', a.order_id, { attestationId: id });
      });
      return { applied: false };
    }
    const [o] = await this.db.query<any>('SELECT * FROM payment_requests WHERE id=$1', [a.order_id]);
    if (!['PENDING', 'EXPIRED'].includes(o.status)) throw new DomainError('ORDER_NOT_PAYABLE', `Order is ${o.status}`, 409);
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO bank_credits(reference, amount_minor, credited_at, order_tokens, evidence, note) VALUES ($1,$2,$3,$4,'MANUAL_ATTESTATION',$5) ON CONFLICT (reference) DO NOTHING RETURNING id`,
      [a.reference, o.amount_minor, new Date(a.credited_at).toISOString(), [o.provider_order_id], `attested: ${a.note}`],
    );
    if (!rows.length) throw new DomainError('REFERENCE_ALREADY_RECORDED', 'This bank reference was recorded meanwhile', 409);
    const creditId = rows[0].id;
    await this.ingest.matchCredit(creditId);
    let [c] = await this.db.query<any>('SELECT * FROM bank_credits WHERE id=$1', [creditId]);
    if (c.status !== 'MATCHED' && c.payment_id && c.order_id) {
      // An expired order is held by the engine; a reviewer's approval here is the deliberate, dual-controlled release.
      await this.verification.approveReviewedPayment(c.payment_id, actor);
      await this.db.query(`UPDATE bank_credits SET status='MATCHED', match_method='MANUAL_ATTESTATION', updated_at=now() WHERE id=$1`, [creditId]);
      [c] = await this.db.query<any>('SELECT * FROM bank_credits WHERE id=$1', [creditId]);
    }
    if (c.status !== 'MATCHED') throw new DomainError('NOT_APPLIED', `Could not apply the attestation (credit is ${c.status}: ${c.reason ?? 'unknown'})`, 409);
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE payments SET verification_result='MANUAL_ATTESTED' WHERE id=$1`, [c.payment_id]);
      await tx.query(`UPDATE manual_attestations SET status='APPLIED', decided_by=$2, decided_at=now() WHERE id=$1`, [id, actor.id]);
      await this.audit.record(tx, actor, 'bankmail.attestation_applied', 'payment_request', a.order_id, { attestationId: id, reference: a.reference });
    });
    return { applied: true, creditId };
  }
}
