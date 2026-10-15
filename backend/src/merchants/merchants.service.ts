import { Db } from '../db/db';
import { DomainError } from '../common/errors';
import { Actor, AuditService } from '../audit/audit.service';
import { PaymentProvider } from '../provider/provider';
import { isValidVpaFormat } from '../provider/sandbox-bank.provider';
import { ProviderRejection, TransientError } from '../common/errors';

/** Loose legal-name vs bank-name comparison: share of the bank name's words found in the legal name (ignores case, punctuation, company suffixes). */
export function nameMatches(legalName: string, bankName: string): boolean {
  const words = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['pvt', 'ltd', 'private', 'limited', 'llp', 'and', 'co', 'the'].includes(w));
  const legal = new Set(words(legalName));
  const bank = words(bankName);
  return bank.length > 0 && bank.filter((w) => legal.has(w)).length / bank.length >= 0.5;
}

export class MerchantsService {
  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly provider?: PaymentProvider) {}

  /** Creates the merchant, its login and a verification case. Merchant stays PENDING_VERIFICATION. */
  async register(input: { email: string; passwordHash: string; legalName: string; displayName: string }) {
    return this.db.transaction(async (tx) => {
      const taken = await tx.query('SELECT 1 FROM users WHERE email = $1', [input.email.toLowerCase()]);
      if (taken.length) throw new DomainError('EMAIL_TAKEN', 'Email already registered', 409);
      const [m] = await tx.query<{ id: string }>(`INSERT INTO merchants(legal_name, display_name) VALUES ($1,$2) RETURNING id`, [
        input.legalName,
        input.displayName,
      ]);
      const [u] = await tx.query<{ id: string }>(
        `INSERT INTO users(email, password_hash, role, merchant_id) VALUES ($1,$2,'MERCHANT',$3) RETURNING id`,
        [input.email.toLowerCase(), input.passwordHash, m.id],
      );
      const [c] = await tx.query<{ id: string }>(`INSERT INTO merchant_verification_cases(merchant_id) VALUES ($1) RETURNING id`, [m.id]);
      await this.audit.record(tx, { id: u.id, role: 'MERCHANT', merchantId: m.id }, 'merchant.registered', 'merchant', m.id);
      return { merchantId: m.id, userId: u.id, verificationCaseId: c.id };
    });
  }

  async decideVerification(caseId: string, decision: 'APPROVED' | 'REJECTED', actor: Actor, notes = '') {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.query<any>('SELECT * FROM merchant_verification_cases WHERE id=$1 FOR UPDATE', [caseId]);
      if (!c) throw new DomainError('NOT_FOUND', 'Verification case not found', 404);
      if (c.status === 'APPROVED' || c.status === 'REJECTED') throw new DomainError('ALREADY_DECIDED', 'Case already decided', 409);
      await tx.query(`UPDATE merchant_verification_cases SET status=$2, notes=$3, decided_by=$4, decided_at=now() WHERE id=$1`, [
        caseId,
        decision,
        notes,
        actor.id,
      ]);
      await tx.query(`UPDATE merchants SET status=$2 WHERE id=$1`, [c.merchant_id, decision === 'APPROVED' ? 'ACTIVE' : 'REJECTED']);
      await this.audit.record(tx, actor, `merchant.verification.${decision.toLowerCase()}`, 'merchant', c.merchant_id, { caseId });
    });
  }

  /**
   * Registers a settlement destination reference (a provider-held token, never a raw account number).
   * It cannot receive payouts until an administrator verifies it.
   */
  async addDestination(merchantId: string, input: { label: string; providerDestinationRef: string; maskedAccount: string }, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.query<{ id: string }>(
        `INSERT INTO merchant_settlement_destinations(merchant_id, provider_destination_ref, label, masked_account)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [merchantId, input.providerDestinationRef, input.label, input.maskedAccount],
      );
      await this.audit.record(tx, actor, 'destination.added', 'merchant', merchantId, { destinationId: d.id, masked: input.maskedAccount });
      return d.id;
    });
  }

  /**
   * Registers a merchant's UPI ID as a payout destination. The bank validates it and returns a token + the account-holder name;
   * only the token, the masked UPI ID and the holder name are stored, never the UPI ID. It cannot receive payouts until an
   * administrator verifies it (and, if the bank's name does not match the merchant's legal name, explicitly accepts the mismatch).
   */
  async addUpiDestination(merchantId: string, vpa: string, actor: Actor) {
    if (!this.provider?.registerUpiBeneficiary) throw new DomainError('CAPABILITY_UNAVAILABLE', 'The payment provider does not support UPI payouts', 501);
    if (!isValidVpaFormat(vpa)) throw new DomainError('INVALID_VPA', 'Not a valid UPI ID (expected name@bank)');
    let ben;
    try {
      ben = await this.provider.registerUpiBeneficiary(vpa);
    } catch (e) {
      if (e instanceof ProviderRejection) throw new DomainError(e.code, e.message, 422);
      if (e instanceof TransientError) throw new DomainError('PROVIDER_UNAVAILABLE', 'Could not validate the UPI ID right now; try again', 503);
      throw e;
    }
    return this.db.transaction(async (tx) => {
      const [d] = await tx.query<{ id: string }>(
        `INSERT INTO merchant_settlement_destinations(merchant_id, provider_destination_ref, label, masked_account, beneficiary_kind, beneficiary_name)
         VALUES ($1,$2,'UPI',$3,'UPI',$4) RETURNING id`,
        [merchantId, ben.ref, ben.maskedVpa, ben.holderName],
      );
      // The same UPI ID registered by a different merchant is a classic diversion pattern: flag it for the reviewer.
      const others = await tx.query<any>(
        `SELECT DISTINCT merchant_id FROM merchant_settlement_destinations WHERE provider_destination_ref=$1 AND merchant_id <> $2 AND status <> 'DISABLED'`,
        [ben.ref, merchantId],
      );
      if (others.length) {
        await tx.query(`INSERT INTO risk_reviews(subject_type, subject_id, reason, detail) VALUES ('destination',$1,'DUPLICATE_DESTINATION',$2)`, [d.id, JSON.stringify({ otherMerchants: others.length })]);
      }
      await this.audit.record(tx, actor, 'destination.upi_added', 'merchant', merchantId, { destinationId: d.id, masked: ben.maskedVpa });
      return { id: d.id, maskedVpa: ben.maskedVpa, beneficiaryName: ben.holderName, duplicateFlagged: others.length > 0 };
    });
  }

  /** Verifying a new destination retires the previously verified one. Always audited. */
  async verifyDestination(destinationId: string, actor: Actor, opts: { confirmReview?: boolean } = {}) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.query<any>('SELECT * FROM merchant_settlement_destinations WHERE id=$1 FOR UPDATE', [destinationId]);
      if (!d) throw new DomainError('NOT_FOUND', 'Destination not found', 404);
      const [m] = await tx.query<any>('SELECT status FROM merchants WHERE id=$1 FOR UPDATE', [d.merchant_id]);
      if (m.status !== 'ACTIVE') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant must be verified first', 409);
      if (d.beneficiary_name) {
        const [mm] = await tx.query<any>('SELECT legal_name FROM merchants WHERE id=$1', [d.merchant_id]);
        if (!nameMatches(mm.legal_name, d.beneficiary_name) && !opts.confirmReview) {
          throw new DomainError('NAME_MISMATCH', `Bank name "${d.beneficiary_name}" does not match the merchant's legal name; confirm explicitly after checking`, 409);
        }
      }
      const [dup] = await tx.query<any>(`SELECT 1 FROM risk_reviews WHERE subject_type='destination' AND subject_id=$1 AND status='OPEN'`, [destinationId]);
      if (dup && !opts.confirmReview) throw new DomainError('OPEN_RISK_REVIEW', 'This destination has an open risk review (same UPI ID used by another merchant); resolve it and confirm explicitly', 409);
      await tx.query(`UPDATE merchant_settlement_destinations SET status='DISABLED' WHERE merchant_id=$1 AND status='VERIFIED'`, [d.merchant_id]);
      await tx.query(`UPDATE merchant_settlement_destinations SET status='VERIFIED', verified_by=$2, verified_at=now() WHERE id=$1`, [
        destinationId,
        actor.id,
      ]);
      await tx.query(`UPDATE risk_reviews SET status='APPROVED', decided_by=$2, decided_at=now() WHERE subject_type='destination' AND subject_id=$1 AND status='OPEN'`, [destinationId, actor.id]);
      await this.audit.record(tx, actor, 'destination.verified', 'merchant', d.merchant_id, { destinationId, acceptedNameMismatch: !!opts.confirmReview });
    });
  }

  async setStatus(merchantId: string, status: 'ACTIVE' | 'SUSPENDED', actor: Actor, reason = '') {
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE merchants SET status=$2 WHERE id=$1', [merchantId, status]);
      await this.audit.record(tx, actor, `merchant.${status.toLowerCase()}`, 'merchant', merchantId, { reason });
    });
  }

  async get(merchantId: string) {
    const [m] = await this.db.query<any>('SELECT * FROM merchants WHERE id=$1', [merchantId]);
    return m;
  }
}
