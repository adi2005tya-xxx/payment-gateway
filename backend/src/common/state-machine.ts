import { DomainError } from './errors';

export const PAYMENT_TRANSITIONS: Record<string, string[]> = {
  CREATED: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'UNDER_REVIEW'],
  PENDING: ['PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'UNDER_REVIEW'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'UNDER_REVIEW'],
  UNDER_REVIEW: ['SUCCEEDED', 'FAILED', 'REFUNDED'],
  SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'],
  FAILED: [],
  EXPIRED: [],
  REFUNDED: [],
  REVERSED: [],
};

export const PAYOUT_TRANSITIONS: Record<string, string[]> = {
  NOT_ELIGIBLE: ['ELIGIBLE'],
  ELIGIBLE: ['QUEUED', 'UNDER_REVIEW'],
  UNDER_REVIEW: ['QUEUED', 'FAILED'],
  QUEUED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PROCESSING', 'SUCCEEDED', 'FAILED', 'UNDER_REVIEW'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'UNDER_REVIEW'],
  SUCCEEDED: ['RETURNED'],
  FAILED: [],
  RETURNED: [],
};

export function assertTransition(table: Record<string, string[]>, from: string, to: string): void {
  if (!table[from]?.includes(to)) throw new DomainError('INVALID_TRANSITION', `Illegal transition ${from} -> ${to}`, 409);
}
