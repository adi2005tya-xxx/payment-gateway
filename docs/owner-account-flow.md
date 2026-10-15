# Owner-account flow (sandbox): customer pays the owner, merchant is paid by UPI ID

> **Status: sandbox only.** `PAYMENT_MODE=live` stays blocked. Collecting customers' money in an ordinary account and passing it on to merchants is, in India, likely regulated payment-aggregator activity. Whether your structure is permitted is a question for Indian fintech counsel or an authorised partner (see [regulatory-checklist.md](regulatory-checklist.md)). Nothing here is legal advice, and nothing here involves a real bank.

Enable with `PROVIDER_KIND=owner-account-sandbox` (plus `OWNER_UPI_ID`, optional `OWNER_OPENING_BALANCE_MINOR`, `UPI_PAYOUT_LIMIT_MINOR`).

## Workflow
1. **Merchant onboarding.** Merchant registers and is approved. They submit their **UPI ID** (`POST /merchant/destinations/upi`). The bank validates it and returns a token and the account-holder name. The platform stores only the token, a masked ID (`ra****@okhdfc`) and the holder name; the raw UPI ID is never stored, logged or audited (tested).
2. **Destination approval.** An administrator (MFA step-up) compares the bank's holder name with the merchant's legal name (`GET /admin/destinations` shows `nameMatches`). A mismatch, or the same UPI ID registered by another merchant, blocks approval unless the admin explicitly confirms (`confirmReview: true`); the override is audited. A pending destination cannot receive payouts.
3. **Payment request.** The merchant creates a request. The platform generates a **unique reference** (`GW…`) and a UPI link/QR: `upi://pay?pa=<owner UPI ID>&am=<exact amount>&cu=INR&tr=<reference>&tn=<reference>`. A QR is never proof of payment.
4. **Customer pays** the owner's UPI ID.
5. **Confirmation.** The bank reports the credit (signed webhook; in production also a statement feed). The verification engine looks the credit up with the bank, then requires: known reference, same merchant, exact amount and currency, request still payable. Only then is the journal posted (merchant payable + platform fee).
6. **Anything not certain is held, not guessed:** missing or mistyped reference, wrong amount, a credit tied to a different merchant, a late payment after expiry, a duplicate payment for one order. The money sits in the suspense account and a risk review opens; an admin approves it to the right merchant or refunds it.
7. **Payout.** The merchant requests a payout (idempotency key). The funds are reserved at once. Before sending, the engine checks that the **owner account actually holds the money** (otherwise the payout waits, QUEUED, with one `PROVIDER_BALANCE_LOW` alert and nothing sent), then pays the merchant's UPI ID through the bank. Definitive bank refusals (UPI per-transaction limit, unknown beneficiary, insufficient funds) mark the payout FAILED and release the reservation. A timeout never causes a second transfer (lookup by reference first, same idempotency key).
8. **Reconciliation** compares the ledger with the bank's credits and debits; the disaster-recovery procedure treats this bank account like any other provider.

## What is real and what is simulated
Implemented and tested: everything in the application (13 tests in `test/owner-account.spec.ts`, plus the existing suite). Simulated: the bank (`SandboxBankAccountProvider`): credits, balance, beneficiary validation, UPI limit, payouts.

## What a real bank adapter would need (not built)
- A bank/payout-provider API (or account-aggregator/statement feed) that: reports credits with UTR and the customer's remark/reference; lets us fetch a credit by UTR; validates a UPI ID and returns the account-holder name; creates UPI payouts with an idempotency key and lookup by our reference; reports the account balance; lists transactions for reconciliation. **Whether a given bank allows third-party payouts from a collection account is a contractual question.** See the [provider checklist](provider-integration-checklist.md).
- Verified behaviour of the customer's UPI app regarding `tr`/`tn`: apps may drop or truncate these. The review path (not guessing) is the safety net; measure the real drop rate in testing.
- Daily limits of the bank and payout timing windows. (Payouts above the per-transaction limit are already split into a group of transfers; see operations.md.)
- Refunds to the paying customer need the payer's account details from the bank's credit record (the sandbox does not model this).
- Statement-based reconciliation and a holding policy for the owner's own funds vs merchants' funds (the ledger already separates them; the physical account does not).
- Tax/compliance handling (GST on fees, TDS, reporting): needs professional advice.

## Risks to keep in mind
A single account receiving everything makes the **reference the only link** between a payment and a merchant; the owner's personal and business money must not be mixed in that account; a compromised admin with step-up can still approve a diversion, which is why destination approval is dual-sensitive (name match, duplicate flag, audit) and payouts stay under limits and review thresholds.
