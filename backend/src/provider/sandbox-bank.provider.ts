import { createHash, randomBytes, randomInt } from 'crypto';
import { ProviderRejection } from '../common/errors';
import { ProviderOrder, ProviderPayment, ProviderPayout, ProviderRefund, UpiBeneficiary } from './provider';
import { SandboxProvider } from './sandbox.provider';

const VPA = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$/;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const normaliseVpa = (v: string) => v.trim().toLowerCase();
export const isValidVpaFormat = (v: string) => VPA.test(normaliseVpa(v));
export function maskVpa(vpa: string): string {
  const [name, handle] = normaliseVpa(vpa).split('@');
  return `${name.slice(0, 2)}****@${handle}`;
}

/**
 * SANDBOX stand-in for "the owner's own bank account": customers pay the owner's UPI ID, the bank reports credits,
 * and payouts to merchants' UPI IDs are made from the same account. Simulated only: no real bank is involved and nothing here
 * represents real money. A real adapter would be a bank/payout-provider integration written from that provider's documentation.
 *
 * Matching model: the bank credit carries only what the customer's UPI app passed along. Each payment request gets a unique
 * reference (UPI `tr`/`tn`); a credit without a reference, with an unknown reference or with the wrong amount is NOT guessed,
 * it is held for review by the verification engine.
 */
export class SandboxBankAccountProvider extends SandboxProvider {
  /** Spendable balance of the simulated owner account. */
  private balanceMinor: number;
  private readonly beneficiaries = new Set<string>();
  private readonly holders = new Map<string, string>();

  constructor(
    webhookSecret: string,
    baseUrl: string,
    readonly ownerVpa: string,
    opts: { openingBalanceMinor?: number; upiPayoutLimitMinor?: number } = {},
  ) {
    super(webhookSecret, baseUrl, 'owner-account');
    this.balanceMinor = opts.openingBalanceMinor ?? 0;
    this.upiPayoutLimitMinor = opts.upiPayoutLimitMinor ?? 10_000_000; // INR 1,00,000 per transaction (typical UPI cap; configure to the real bank's)
  }
  readonly upiPayoutLimitMinor: number;
  get payoutLimitMinor(): number {
    return this.upiPayoutLimitMinor;
  }

  // ------------------------------------------------------------------ collection
  override async createOrder(i: Parameters<SandboxProvider['createOrder']>[0]): Promise<ProviderOrder> {
    const reference = 'GW' + Array.from(randomBytes(10), (b) => B32[b % B32.length]).join('');
    this.orders.set(reference, { referenceId: i.referenceId, merchantRef: i.merchantRef, amountMinor: i.amountMinor, currency: i.currency });
    const q = new URLSearchParams({ pa: this.ownerVpa, pn: i.merchantName.slice(0, 40), am: (i.amountMinor / 100).toFixed(2), cu: i.currency, tr: reference, tn: reference });
    return { providerOrderId: reference, checkoutUrl: `${this.baseUrl}/pay/sandbox/${reference}`, qrPayload: `upi://pay?${q.toString()}` };
  }

  /**
   * Simulates the customer paying the owner's UPI ID and the bank reporting the credit.
   * `reference` is what the customer's app passed (null = it was dropped), `amountMinor` what actually arrived.
   */
  simulateBankCredit(reference: string | null, opts: { amountMinor?: number; merchantRef?: string } = {}) {
    const order = reference ? this.orders.get(reference) : undefined;
    const amountMinor = opts.amountMinor ?? order?.amountMinor;
    if (amountMinor === undefined) throw new Error('amount required for a credit without a known reference');
    const payment: ProviderPayment = {
      id: `UTR${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}${String(randomInt(0, 1000)).padStart(3, '0')}`,
      orderId: reference ?? '',
      amountMinor,
      currency: 'INR',
      status: 'captured',
      merchantRef: opts.merchantRef ?? order?.merchantRef ?? '',
      refundedMinor: 0,
    };
    this.payments.set(payment.id, payment);
    this.balanceMinor += amountMinor;
    return { payment, webhook: this.signedWebhook('payment.credited', payment) };
  }

  // ------------------------------------------------------------------ beneficiaries + balance
  async registerUpiBeneficiary(rawVpa: string): Promise<UpiBeneficiary> {
    const vpa = normaliseVpa(rawVpa);
    if (!VPA.test(vpa)) throw new ProviderRejection('INVALID_VPA', 'Not a valid UPI ID');
    if (vpa.endsWith('@invalid')) throw new ProviderRejection('VPA_NOT_FOUND', 'The bank could not find this UPI ID');
    const ref = 'ben_sbx_' + createHash('sha256').update(vpa).digest('hex').slice(0, 12);
    this.beneficiaries.add(ref);
    return { ref, holderName: this.holders.get(vpa) ?? 'SANDBOX ACCOUNT HOLDER', maskedVpa: maskVpa(vpa) };
  }

  /** Test hook: what name the bank returns for a UPI ID. */
  setVpaHolder(vpa: string, name: string) {
    this.holders.set(normaliseVpa(vpa), name);
  }

  async getBalance(): Promise<number> {
    return this.balanceMinor;
  }

  /** Test hook: money arriving in the account from elsewhere (e.g. the owner tops up). */
  topUp(amountMinor: number) {
    this.balanceMinor += amountMinor;
  }

  // ------------------------------------------------------------------ payouts / refunds leave the same account
  override async createPayout(i: Parameters<SandboxProvider['createPayout']>[0]): Promise<ProviderPayout> {
    const isNew = !this.payoutsByKey.has(i.idempotencyKey);
    if (isNew) {
      // Definitive refusals: nothing is executed, so the platform may release the reservation.
      if (i.amountMinor > this.upiPayoutLimitMinor) throw new ProviderRejection('UPI_LIMIT_EXCEEDED', `Above the per-transaction UPI limit of ${this.upiPayoutLimitMinor}`);
      if (!this.beneficiaries.has(i.destinationRef)) throw new ProviderRejection('UNKNOWN_BENEFICIARY', 'Beneficiary not registered with the bank');
      if (i.amountMinor > this.balanceMinor) throw new ProviderRejection('INSUFFICIENT_FUNDS', 'Account balance too low');
      // Money leaves unless the bank refused it (payoutBehavior 'fail') or never saw the request.
      if (this.payoutBehavior !== 'fail' && this.payoutBehavior !== 'timeout_before_accept') this.balanceMinor -= i.amountMinor;
    }
    return super.createPayout(i);
  }

  override async createRefund(i: Parameters<SandboxProvider['createRefund']>[0]): Promise<ProviderRefund> {
    const isNew = !this.refundsByKey.has(i.idempotencyKey);
    const r = await super.createRefund(i);
    if (isNew) this.balanceMinor -= i.amountMinor;
    return r;
  }
}
