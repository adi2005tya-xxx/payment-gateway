import { Db } from '../db/db';
import { Actor } from '../audit/audit.service';
import { MerchantsService } from '../merchants/merchants.service';
import { PaymentRequestsService } from './payments.service';

const MERCHANT_EMAIL = 'demo-merchant@demo.invalid';
const ADMIN_EMAIL = 'demo-approver@demo.invalid';
/** A password hash that matches no password, so these two accounts can never be logged into. */
const NO_LOGIN = 'disabled';

/**
 * "Try a test payment": lets a visitor start a Rs 1 payment without any account, against one built-in demo merchant.
 * Only reachable when DEMO_PAYMENTS_ENABLED=true and the provider is in test mode (see the controller). Amount is fixed server-side.
 */
export class DemoPaymentsService {
  private merchant: Promise<{ merchantId: string; userId: string }> | null = null;

  constructor(private readonly db: Db, private readonly merchants: MerchantsService, private readonly requests: PaymentRequestsService) {}

  async createDemoPayment(): Promise<{ token: string }> {
    const m = await this.ensureMerchant();
    const actor: Actor = { id: m.userId, role: 'MERCHANT', merchantId: m.merchantId };
    const req = await this.requests.create(m.merchantId, { orderReference: `DEMO-${Date.now()}`, amountMinor: 100, description: 'Test payment (demo)', expiresInMinutes: 60 }, actor);
    return { token: req.public_token };
  }

  private ensureMerchant() {
    this.merchant ??= this.load().catch((e) => {
      this.merchant = null; // retry on the next request
      throw e;
    });
    return this.merchant;
  }

  private async load() {
    const [existing] = await this.db.query<{ id: string; merchant_id: string }>('SELECT id, merchant_id FROM users WHERE email=$1', [MERCHANT_EMAIL]);
    if (existing) return { merchantId: existing.merchant_id, userId: existing.id };

    const [admin] = await this.db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role) VALUES ($1,$2,'ADMIN') ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`,
      [ADMIN_EMAIL, NO_LOGIN],
    );
    const approver: Actor = { id: admin.id, role: 'ADMIN' };
    const reg = await this.merchants.register({ email: MERCHANT_EMAIL, passwordHash: NO_LOGIN, legalName: 'Demo Traders Pvt Ltd', displayName: 'Demo Traders' });
    await this.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', approver);
    const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
    const dest = await this.merchants.addDestination(reg.merchantId, { label: 'Primary', providerDestinationRef: 'fa_demo_0001', maskedAccount: 'XXXX1234' }, actor);
    await this.merchants.verifyDestination(dest, approver);
    return { merchantId: reg.merchantId, userId: reg.userId };
  }
}
