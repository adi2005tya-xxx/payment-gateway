import { DomainError, ProviderRejection } from '../../common/errors';
import { ParsedWebhook, PaymentProvider, ProviderOrder, ProviderPayment, ProviderPayout, ProviderRefund } from '../provider';

/**
 * Base for hosted-checkout gateways (Razorpay, PhonePe, Paytm). These are payment ACCEPTORS: they collect from customers.
 * Paying merchants out is a different product at every one of them (RazorpayX, PhonePe payouts, Paytm payouts) that needs its own
 * contract, so it is refused here instead of being faked (see docs/provider-integration-checklist.md).
 */
export abstract class HostedGatewayProvider implements PaymentProvider {
  abstract readonly name: string;
  abstract readonly isSandbox: boolean;
  readonly defaultOrderExpiryMinutes = 30;

  abstract createOrder(input: Parameters<PaymentProvider['createOrder']>[0]): Promise<ProviderOrder>;
  abstract getPayment(id: string): Promise<ProviderPayment>;
  abstract verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  abstract parseWebhook(rawBody: string): ParsedWebhook;
  abstract createRefund(input: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund>;
  abstract listPayments(): Promise<ProviderPayment[]>;

  async createPayout(): Promise<ProviderPayout> {
    throw new ProviderRejection('PAYOUTS_UNSUPPORTED', `${this.name}: this adapter collects payments only; merchant payouts are not supported`);
  }
  async getPayoutByReference(): Promise<ProviderPayout | null> {
    return null;
  }
  async listPayouts(): Promise<ProviderPayout[]> {
    return [];
  }

  protected noReportApi(): never {
    throw new DomainError('CAPABILITY_UNAVAILABLE', `${this.name} has no API to list transactions; reconcile against the provider dashboard settlement report`, 501);
  }
}

export function notFound(what: string): Error {
  return new Error(`NOT_FOUND ${what}`);
}
