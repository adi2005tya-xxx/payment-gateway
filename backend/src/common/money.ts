import { DomainError } from './errors';

export const SUPPORTED_CURRENCIES = ['INR'] as const;
export const MIN_AMOUNT_MINOR = 100; // 1 INR
export const MAX_AMOUNT_MINOR = 100_000_000; // 10,00,000 INR per payment request

export function assertAmount(minor: unknown, currency: string): number {
  if (!SUPPORTED_CURRENCIES.includes(currency as any)) throw new DomainError('UNSUPPORTED_CURRENCY', `Unsupported currency ${currency}`);
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) throw new DomainError('INVALID_AMOUNT', 'Amount must be an integer in minor units');
  if (minor < MIN_AMOUNT_MINOR || minor > MAX_AMOUNT_MINOR) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount outside permitted range');
  return minor;
}

/** Platform fee in minor units, round-half-up, computed with integers only. */
export function feeFor(amountMinor: number, feeBps: number): number {
  return Math.floor((amountMinor * feeBps + 5000) / 10000);
}
