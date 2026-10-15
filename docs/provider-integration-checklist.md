# Provider integration checklist & capability matrix

Implement a real adapter by satisfying `src/provider/provider.ts` using **only the provider's official documentation and approved credentials**. If a capability is missing, document it here and keep the affected workflow disabled — never fake it.

## Capability matrix (fill in per provider)
| Capability | Contract method | Sandbox adapter | Real provider |
|---|---|---|---|
| Create order/payment request with our merchant reference | `createOrder` | ✅ simulated | ☐ |
| Dynamic QR / checkout link | `createOrder` → `qrPayload` | ✅ link only | ☐ |
| Static/merchant QR with reference matching | — (not implemented; unmatched → review) | ❌ | ☐ |
| Payment status API | `getPayment` | ✅ | ☐ |
| Webhook signature scheme | `verifyWebhook` (over raw body) / `parseWebhook` | ✅ HMAC-SHA256 | ☐ |
| Refunds with idempotency | `createRefund` | ✅ | ☐ |
| Third-party merchant payouts | `createPayout` | ✅ | ☐ **must be contractually approved** |
| **Payout idempotency key** | `createPayout.idempotencyKey` | ✅ | ☐ **required; if absent, payouts must not be enabled** |
| Payout lookup by our reference | `getPayoutByReference` | ✅ | ☐ **required** |
| Transaction / settlement reports | `listPayments`, `listPayouts` | ✅ | ☐ |
| Sub-merchant / KYC onboarding | not in contract yet | ❌ | ☐ |
| UPI ID validation + beneficiary token + holder name (optional capability) | `registerUpiBeneficiary` | ✅ simulated (`owner-account-sandbox`) | ☐ |
| Account balance for the payout account (optional capability) | `getBalance` | ✅ simulated | ☐ |
| Credits reported with the customer's reference (`tr`/`tn`) | webhook + `getPayment` | ✅ simulated | ☐ **measure drop rate** |
| Definitive refusal signalling (limit, unknown beneficiary, insufficient funds) | `ProviderRejection` | ✅ | ☐ |

## Steps
1. Obtain sandbox credentials; store in a secrets manager (never in git).
2. Implement adapter; map provider statuses to `ProviderPaymentStatus` / `ProviderPayoutStatus` exactly as documented. Throw `TransientError` for timeouts/5xx and `ProviderRejection` for definitive refusals (nothing executed); never a plain error for either.
3. Record fixtures from real sandbox webhooks; add signature tests with the provider's published examples.
4. Run the existing suite against the adapter's contract (forged/duplicate/out-of-order/timeouts/payout-ambiguity).
5. Validate reconciliation against real settlement reports and bank statements.
6. Wire the adapter in `src/main.ts`; only then discuss relaxing the `PAYMENT_MODE=live` block, after the regulatory checklist is complete.
