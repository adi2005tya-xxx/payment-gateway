/**
 * Provider-agnostic integration contract. A real adapter must implement only capabilities the provider
 * documents and has contractually approved; anything unsupported must throw, never be faked.
 */
export type ProviderPaymentStatus = 'created' | 'pending' | 'captured' | 'failed' | 'refunded';

export interface ProviderPayment {
  id: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  status: ProviderPaymentStatus;
  /** Our merchant reference that was attached to the order at creation (provider "notes"/"reference"). */
  merchantRef: string;
  refundedMinor: number;
}

export interface ProviderOrder {
  providerOrderId: string;
  checkoutUrl: string;
  qrPayload: string;
}

export type ProviderPayoutStatus = 'processing' | 'processed' | 'failed' | 'reversed';
export interface ProviderPayout {
  id: string;
  referenceId: string;
  amountMinor: number;
  currency: string;
  status: ProviderPayoutStatus;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: 'processed' | 'failed' | 'pending';
}

export interface ParsedWebhook {
  eventId: string;
  type: string;
  providerPaymentId?: string;
  providerOrderId?: string;
}

/** Result of registering a UPI ID as a payout beneficiary. The raw UPI ID is never stored by the platform: only this token and the masked form. */
export interface UpiBeneficiary {
  /** Provider-held token used for payouts. */
  ref: string;
  /** Name the bank returns for the UPI ID (to compare with the merchant's legal name). */
  holderName: string;
  /** e.g. ra****@okhdfc */
  maskedVpa: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly isSandbox: boolean;

  // ---- Optional capabilities. A workflow that needs one must refuse to run (not fake it) when it is absent.
  /** Validates a UPI ID with the bank and returns a payout beneficiary token. Throws ProviderRejection if the UPI ID does not exist. */
  registerUpiBeneficiary?(vpa: string): Promise<UpiBeneficiary>;
  /** Spendable balance (minor units) of the account payouts are made from. */
  getBalance?(): Promise<number>;
  /** Per-transaction payout cap (minor units). Larger payouts are split into several transfers. */
  readonly payoutLimitMinor?: number;
  /** True if orders carry an operator-supplied payee UPI ID. */
  readonly supportsPayeeVpa?: boolean;
  /** How many paise may be added to make an order's payable amount unique among open orders. */
  readonly uniqueAmountMaxPaise?: number;
  /** Orders get this expiry (minutes) when none is given. */
  readonly defaultOrderExpiryMinutes?: number;
  /** Unpaid orders stay PENDING this long after expiry, so a delayed bank alert can still confirm them. */
  readonly orderExpiryGraceMinutes?: number;

  createOrder(input: {
    referenceId: string;
    merchantRef: string;
    amountMinor: number;
    currency: string;
    expiresAt?: Date;
    merchantName: string;
    /** UPI ID that will receive the money (only for providers with supportsPayeeVpa). */
    payeeVpa?: string;
  }): Promise<ProviderOrder>;

  /** Must throw TransientError on timeout/outage; NotFoundError if the provider has no such payment. */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;

  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  parseWebhook(rawBody: string): ParsedWebhook;

  createRefund(input: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund>;

  createPayout(input: {
    referenceId: string;
    amountMinor: number;
    currency: string;
    destinationRef: string;
    idempotencyKey: string;
  }): Promise<ProviderPayout>;
  getPayoutByReference(referenceId: string): Promise<ProviderPayout | null>;

  /** Gateways with a browser-side custom checkout (razorpay.js): the PUBLIC key id the page may use. Never a secret. */
  readonly customCheckoutKeyId?: string;
  /** If the payment was only authorized (not auto-captured), captures it. Call only after the checkout signature was verified. */
  captureIfAuthorized?(providerPaymentId: string): Promise<void>;

  /** Hosted-checkout gateways: verifies the signature the checkout hands the browser after payment (early UX signal only; money is confirmed via the status API). */
  verifyCheckoutReturn?(r: { orderId: string; paymentId: string; signature: string }): boolean;

  /** Hosted-checkout gateways: renders the page a customer pays on (served by the API at GET /pay/:provider/:orderId). */
  renderCheckoutPage?(orderId: string, query: Record<string, string>): Promise<{ html: string; csp: string }>;

  /** Provider-side records for reconciliation (settlement/transaction report equivalents). */
  listPayments(): Promise<ProviderPayment[]>;
  listPayouts(): Promise<ProviderPayout[]>;
}

export const PROVIDER = Symbol('PROVIDER');
