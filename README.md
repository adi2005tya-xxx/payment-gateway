# Gateway — payment collection, verification & merchant settlement (sandbox-first)

Customer pays → platform receives webhook → backend **independently verifies** with the provider → correct merchant identified → double-entry ledger posted → payout engine pays the merchant → payout verified and reconciled.

**Status: sandbox MVP backend. No real money moves.** `PAYMENT_MODE=live` is blocked in code until an approved provider adapter exists (see [provider checklist](docs/provider-integration-checklist.md) and [regulatory checklist](docs/regulatory-checklist.md)). Every sandbox payment, payout and journal is flagged `is_sandbox`.

## What exists vs. what is waiting

| Area | State |
|---|---|
| Ledger (append-only, DB-enforced balanced journals), payment verification, state machines, payouts, refunds, reconciliation, durable jobs, audit chain | **Implemented and tested** (180+ automated tests) |
| REST API: auth, merchant, admin, public checkout, webhook, sandbox checkout page | **Implemented** (`backend/`) |
| Sandbox provider with fault injection (outage, payout timeouts, reversals) | **Implemented** |
| Next.js dashboards: customer pay page, merchant area, admin area, MFA flows, step-up dialog (`web/`) - [docs/web.md](docs/web.md) | **Implemented; 12-step real-browser run against the real API passes** |
| Notifications (SMTP), alert routing (webhook), password reset, split UPI payouts, orphan-payout adoption, ops monitor, load test, CI workflow - [docs/operations.md](docs/operations.md) | **Implemented and tested** (CI workflow not yet run on GitHub) |
| **TOTP MFA for admins** (enrolment, recovery codes, step-up, controlled recovery) - [docs/mfa.md](docs/mfa.md) | **Implemented and tested** |
| **Disaster recovery**: encrypted backups, PITR, post-restore money-out freeze, integrity checker, real-PostgreSQL drill - [docs/disaster-recovery.md](docs/disaster-recovery.md), [report](docs/dr-test-report.md) | **Implemented; drilled on local PostgreSQL 17 only** |
| **Owner-account flow** (customer pays owner's UPI ID, merchant paid to their UPI ID) - [docs/owner-account-flow.md](docs/owner-account-flow.md) | **Implemented in sandbox; no real bank adapter; legal structure unconfirmed** |
| **UPI QR + automatic confirmation from bank credit emails** (Gmail OAuth read-only, DKIM-verified, your own template, manual review, dashboard) - [docs/bank-email.md](docs/bank-email.md) | **Implemented and tested against synthetic emails and a mock Google; needs YOUR real bank alert sample and a Google OAuth client; not tested against real Gmail/bank** |
| **Confirmation from a phone payment notification / SMS** (device token, trusted-app allowlist, unique-paise amounts, per-credit and daily caps, review) - [docs/phone-notifications.md](docs/phone-notifications.md) | **Implemented and tested with the one real notification text seen so far plus synthetic variants; WEAKER evidence than signed email; Android forwarder app not built or tested here** |
| SQS queue, Redis, KMS-backed keys, passkeys, CSP header, managed-cloud/cross-region backup drill | **Not built** — see [security checklist](docs/security-checklist.md) |
| Real bank/provider adapter, real payouts, KYC, legal structure | **Awaiting counsel, a partner/bank and approvals; cannot be built without them** |

## Quick start

```bash
cd backend
npm install     # the web app is separate: see docs/web.md
cp .env.example .env        # fill JWT_SECRET (>=32 chars), PROVIDER_WEBHOOK_SECRET (>=16), MFA_ENCRYPTION_KEY (32 random bytes, base64), optional bootstrap admin
npm test                    # 180+ tests, embedded Postgres (PGlite) — no database needed
npm start                   # API on :3001, embedded DB in .data/pglite, in-process worker
```

Set the variables in your shell or load `.env` with your preferred tool (the app reads `process.env`).
Production-style runs use `DATABASE_URL` (PostgreSQL ≥ 14); migrations in `backend/migrations` apply automatically at start.

### Try the sandbox flow
1. `POST /auth/register` (merchant) → admin `POST /admin/verification-cases/:id/decision` → merchant `POST /merchant/destinations` → admin `POST /admin/destinations/:id/verify`.
2. Merchant `POST /merchant/payment-requests` → open the returned `checkoutUrl` → click *Simulate successful payment*. That page does **not** confirm payment; it triggers a signed webhook, and the worker verifies it.
3. `GET /merchant/balance`, then `POST /merchant/payouts` with an `Idempotency-Key`.

## Design in one page
Read [docs/architecture.md](docs/architecture.md): funds flow, state machines, ledger accounts, concurrency/idempotency controls, threat model, assumptions.

## Key assumptions (made safe-by-default, flagged for review)
- Currency INR only; amounts are integer paise; fee = round-half-up basis points per merchant.
- Provider fees are not modelled yet (needs the real fee schedule).
- Refunds refund the platform fee pro rata; a merchant's payable may go negative after a refund (platform is owed by the merchant).
- Settlement destinations are provider-held tokens; raw account numbers are never stored.
- Static/merchant QR is **not** implemented: unmatched payments go to review rather than being guessed.
- Admins must enrol TOTP MFA on first login; privileged routes return 403 until they do ([docs/mfa.md](docs/mfa.md)).
- Roles are two fixed roles (ADMIN, MERCHANT); a `permissions` table is deferred until finer roles are needed.
