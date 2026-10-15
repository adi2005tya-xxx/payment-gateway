export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Thrown for transient failures (provider outage, timeout). Callers keep state unresolved and retry. */
export class TransientError extends Error {}

/** Handler asks the job runner to run it again later WITHOUT consuming a retry attempt (e.g. money-out freeze). */
export class DeferJob extends TransientError {
  constructor(public readonly delayMs: number, message = 'deferred') {
    super(message);
  }
}

/** The provider definitively refused the request (invalid beneficiary, limit exceeded, insufficient funds...). Unlike TransientError the outcome is known: nothing was executed. */
export class ProviderRejection extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
