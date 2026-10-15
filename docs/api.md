# API reference (v0, sandbox)

JSON over HTTPS. `Authorization: Bearer <token>` from `POST /auth/login`. Money is integer **paise**. Errors: `{ "error": "CODE", "message": "..." }` (validation: `VALIDATION_FAILED` + `issues`).

## Authentication & MFA
`POST /auth/login` returns `{token, role, mfa: NOT_REQUIRED|ENROL_REQUIRED|CHALLENGE_REQUIRED, expiresAt}`. Until MFA is satisfied the token works **only** on `/auth/*`; other routes return `403 {error:"MFA_REQUIRED", mfa}`. High-risk routes return `403 {error:"STEP_UP_REQUIRED", stepUp:true}` when the last factor check is older than the step-up window.
Bearer endpoints: `POST /auth/logout` | `GET /auth/mfa/status` | `POST /auth/mfa/enrol/start` | `POST /auth/mfa/enrol/confirm {code}` | `POST /auth/mfa/challenge {code | recoveryCode}` | `POST /auth/mfa/step-up {code | recoveryCode}` | `POST /auth/mfa/recovery-codes/regenerate`.
Public: `POST /auth/mfa/recovery-request {email,password}`. Admin: `GET /admin/mfa-recovery-requests`, `POST /admin/mfa-recovery-requests/:id/{approve|reject} {note}`.
Errors: `INVALID_MFA_CODE` 401 (wrong, expired or replayed), `MFA_LOCKED` 429. Details: [mfa.md](mfa.md).

## Public
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{email,password(≥12),legalName,displayName}` → merchant, `PENDING_VERIFICATION` |
| POST | `/auth/login` | `{email,password}` → `{token,role,mfa,expiresAt}` (see MFA above) |
| GET | `/public/pay/:token` | Customer-safe link data + `qrImage` (PNG data URL) |
| POST | `/webhooks/:provider` | Raw body + `x-gateway-signature`. 401 bad signature; 2xx only after durable storage; `{duplicate}` flag |
| GET/POST | `/pay/sandbox/:orderId`, `/sandbox/pay/:orderId` | Sandbox only (404 otherwise): simulated customer payment through the real webhook path |

## UPI collections / bank mailbox (role ADMIN, `PROVIDER_KIND=bank-email`)
`GET /admin/collections/dashboard` (Pending, Paid, Expired, Unmatched, Needs review) | `GET|POST /admin/collections/orders` (`POST {payeeVpa, amountMinor, description?, expiresInMinutes?}` returns `orderId`, `upiLink`, `qrImage`) | `GET /admin/collections/credits` | `POST /admin/collections/credits/:id/{assign {orderId,note}|dismiss {note}}` | `GET|POST /admin/collections/attestations`, `POST .../:id/decision {APPLY|REJECT}` (second administrator) | `GET /admin/mailbox/status`, `POST /admin/mailbox/{connect|disconnect|sync|ingest-eml}`, `GET /admin/mailbox/messages` | `GET|POST /admin/alert-templates`, `POST /admin/alert-templates/test`, `POST /admin/alert-templates/:id/{validate|activate|disable}`. Public: `GET /auth/google/callback` (Google redirect). Sensitive routes need MFA step-up. Details: [bank-email.md](bank-email.md).

## Merchant (role MERCHANT)
`GET /merchant/me` · `POST /merchant/destinations/upi {vpa}` (returns masked UPI ID + bank holder name; admin must verify before payouts) · `POST /merchant/destinations {label,providerDestinationRef,maskedAccount}` · `POST|GET /merchant/payment-requests` (`{orderReference,amountMinor,description?,expiresInMinutes?}`) · `POST /merchant/payment-requests/:id/cancel` · `GET /merchant/payments?status&search&limit&offset` · `GET /merchant/payments/:id` · `GET /merchant/payments.csv` · `GET /merchant/balance` (gross, fees, payable, held, available, in-flight, completed) · `POST /merchant/payouts` (`Idempotency-Key` header or `idempotencyKey`; optional `amountMinor`, default = full available) · `GET /merchant/payouts` · `GET /merchant/notifications`

## Admin (role ADMIN)
`GET /admin/merchants` · `GET /admin/verification-cases` · `POST /admin/verification-cases/:id/decision {decision,notes?}` · `GET /admin/destinations?status=` (with `nameMatches`) · `POST /admin/destinations/:id/verify {confirmReview?}` · `POST /admin/merchants/:id/status {status,reason?}` · `GET /admin/payments` · `GET /admin/payments/:id/events` · `POST /admin/payments/:id/refund {amountMinor,idempotencyKey,reason?}` · `POST /admin/payments/:id/approve-review` · `GET /admin/webhook-events` · `GET /admin/payouts` · `POST /admin/payouts/:id/{approve|reject|retry}` · `GET /admin/risk-reviews` · `GET /admin/alerts` · `GET /admin/audit-logs` · `POST /admin/reconciliation/run` · `GET /admin/reconciliation/runs` · `GET /admin/jobs/dead` · `POST /admin/jobs/:id/replay` · `GET /admin/overview` · `GET /admin/health` · `GET /admin/recovery/status` · `POST /admin/recovery/{freeze|unfreeze}` · `POST /admin/recovery/payouts/:id/resolve` · `GET|POST /admin/recovery/adoptions` · `POST /admin/recovery/adoptions/:id/decision {decision: APPLY|REJECT}`

Payout approval requires an administrator different from the requester (`DUAL_APPROVAL_REQUIRED`). A payout above the provider's per-transaction cap is returned as a group (`POST /merchant/payouts` creates several transfers; approving or rejecting any part applies to all).
Password reset (public, same reply regardless of account): `POST /auth/password-reset/request {email}`, `POST /auth/password-reset/confirm {token,password}`.
