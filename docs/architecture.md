# Architecture

Modular monolith (NestJS) + durable job worker, PostgreSQL as the single source of truth. Domain services are plain classes wired in `src/platform.ts`; Nest only supplies HTTP. The same wiring is used by the API, workers and tests.

```
Customer ──pays──▶ Provider ──signed webhook──▶ POST /webhooks/:provider
                                                   │ 1 verify HMAC over raw body (reject → 401 + alert)
                                                   │ 2 persist webhook_events (UNIQUE provider,event_id) + enqueue job  [one tx]
                                                   ▼ 3 ack 2xx
                         jobs (SKIP LOCKED) ─▶ process_webhook
                                                   │ 4 GET payment from provider  (never trust payload)
                                                   │ 5 match request, merchant, amount, currency, request state
                                                   ▼ 6 ONE DB tx: payments row + COLLECTION journal + request PAID + notification
                                      merchant payable ─▶ payout request ─▶ advance_payout job ─▶ provider payout
                                                   ▼
                                  reconciliation: provider records vs ledger (+ bank statements in production)
```

## Funds flow (target, subject to the approved structure)
Customer funds are held by the **authorised provider/partner**, never in an ordinary company account. The platform only keeps *records*:
- `PLATFORM:PROVIDER_CLEARING` (asset): customer money held at the provider, not yet paid out.
- `MERCHANT:<id>:PAYABLE` (liability): owed to the merchant (gross − fee).
- `PLATFORM:FEE_REVENUE` (revenue): platform fee only — never the whole collection.
- `PLATFORM:PAYOUT_CLEARING` (liability): payouts reserved/in flight.
- `PLATFORM:SUSPENSE` (liability): captured funds not attributable (mismatch, unknown order, late payment) — held for review.

| Event | Journal |
|---|---|
| Verified collection ₹1,000, fee ₹20 | Dr Provider clearing 1000 / Cr Merchant payable 980 / Cr Fee revenue 20 |
| Captured but unmatched | Dr Provider clearing / Cr Suspense; later `SUSPENSE_RELEASE` or refund |
| Payout requested | Dr Merchant payable / Cr Payout clearing (reserve — prevents double spend) |
| Payout confirmed | Dr Payout clearing / Cr Provider clearing |
| Payout failed | Dr Payout clearing / Cr Merchant payable |
| Payout returned later | Dr Provider clearing / Cr Merchant payable |
| Refund | Dr Merchant payable (net) + Dr Fee revenue (pro-rata fee) / Cr Provider clearing |

Rules enforced **in the database**: journals balance at commit (deferred constraint trigger); `ledger_entries`, `ledger_journals`, `audit_logs` reject UPDATE/DELETE; `UNIQUE(kind, ref_type, ref_id)` makes each business event post at most once. Corrections are new journals. Merchant balances are always computed from the ledger.

## State machines (`src/common/state-machine.ts`)
Payment: CREATED→PENDING→PROCESSING→SUCCEEDED→PARTIALLY_REFUNDED→REFUNDED; failures FAILED/EXPIRED; UNDER_REVIEW↔(SUCCEEDED|FAILED|REFUNDED); SUCCEEDED→REVERSED. Terminal states have no outgoing edges, so a late event cannot overwrite them.
Payout: ELIGIBLE→QUEUED→SUBMITTED→PROCESSING→SUCCEEDED→RETURNED; any in-flight state →FAILED or UNDER_REVIEW; UNDER_REVIEW→QUEUED (approval/retry). Payment confirmation and settlement confirmation are separate machines.

## Integrity controls
| Risk | Control |
|---|---|
| Forged webhook | HMAC-SHA256 on raw bytes, constant-time compare, alert on failure |
| Duplicate/replayed webhook | `UNIQUE(provider, provider_event_id)`; payment applied under `UNIQUE(provider, provider_payment_id)` and row locks |
| Client says "paid" | Public API never changes state; PAID only after provider verification |
| Wrong merchant / amount | Provider order carries `merchantRef`; mismatch → suspense + risk review, never credited |
| Provider outage / pending | `TransientError` → job retried with exponential backoff + jitter; nothing guessed; dead-letter + alert + replay |
| Payout timeout | `SUBMITTED` committed *before* provider call; provider looked up by our reference before any create; create uses a stable idempotency key; exhausted retries → `UNDER_REVIEW`, funds stay reserved |
| Double spend | Merchant row `FOR UPDATE` + reserve journal inside the request tx |
| Worker crash | Jobs reclaimed after `locked_until`; handlers idempotent |
| Admin abuse | Backend role checks, dual approval (approver ≠ requester), hash-chained audit log |

## Threat model (summary)
Spoofed provider → signature + status API. Cross-tenant access → merchant id only from verified JWT; every query scoped. Replay → unique keys. Insider tampering → append-only tables, audit chain (`/admin/health` verifies it). Credential stuffing → scrypt, throttling, uniform login error. CSV injection → export neutralises formulas. Open items: MFA, key rotation, WAF, per-IP webhook allow-list, DB role separation (app role without UPDATE on ledger).

## Not yet decided / needs the real provider
Exact event names/fields, status API semantics, settlement report format, fee schedule, payout rails and limits, idempotency support on payouts (**required** — see checklist), static QR reference matching.
