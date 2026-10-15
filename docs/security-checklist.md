# Security checklist & runbook

## Implemented
- [x] TOTP MFA mandatory for admins, server-side sessions, step-up for high-risk routes, recovery codes and controlled recovery - see [mfa.md](mfa.md)
- [x] Account lockouts (password and MFA) with audit and alerts
- [x] scrypt password hashing (min 12 chars), uniform login errors, login/register throttling, global rate limit
- [x] JWT bound to a revocable, expiring server-side session and re-validated on every request; role checks on the backend
- [x] Object-level authorisation: merchant id comes only from the token; all merchant queries are scoped
- [x] zod validation on every body; unknown errors return a generic 500 and never log bodies
- [x] Webhook HMAC over raw bytes, constant-time compare, replay/duplicate protection
- [x] Append-only ledger/audit tables enforced by DB triggers; hash-chained audit log; dual approval for held payouts
- [x] helmet headers; env validation (secret length); live mode hard-blocked
- [x] No raw account numbers, card data or identity documents stored (provider tokens + masked values only)
- [x] CSV export neutralises formula injection

- [x] Bank-alert emails are accepted only if DKIM-verified for the allowlisted bank domain (cryptographic check, not header text), parsed by an operator-supplied and sample-validated template; Gmail access is read-only OAuth with PKCE, tokens encrypted - see [bank-email.md](bank-email.md)
- [x] Phone notifications are accepted only from a device holding a per-device bearer token (stored hashed, revocable), from allowlisted apps, fresh (replay window), under a per-credit and rolling-24h cap, matched only by exact unique amount; they are labelled unverified and never release payouts - see [phone-notifications.md](phone-notifications.md)
- [ ] Phone notifications cannot be authenticated cryptographically: a compromised phone or leaked device token can fake a payment up to the caps. Accepted residual risk; revoke immediately if suspected

## Open (must close before production)
- [ ] WebAuthn/passkeys (phishing-resistant); password reset flow; KMS/HSM-backed MFA key; shared rate-limit store; idle-session timeout
- [ ] Separate DB roles: app role must not have UPDATE/DELETE/TRUNCATE on ledger/audit tables (triggers don't stop TRUNCATE or a superuser)
- [ ] Secrets manager + key rotation (JWT secret, webhook secret); webhook IP allow-listing
- [ ] Managed queue (SQS) with DLQ in place of the Postgres job table, if volume requires it; Redis only if needed for rate limiting at scale
- [ ] Metrics export, paging/escalation and on-call routing for (alert webhook routing and the ops monitor are implemented): `alerts` table kinds (`WEBHOOK_SIGNATURE_FAILURE`, `JOB_DEAD_LETTER`, `PAYOUT_UNKNOWN_OUTCOME`, `RECONCILIATION_DISCREPANCY`, `PAYOUT_RETURNED`), late jobs, stuck payments
- [ ] Scheduled reconciliation + bank-statement import; expiry sweeper is in-process only
- [ ] SAST and an independent pentest. (`npm audit` for production dependencies is clean in both packages and runs in the CI workflow; Dependabot configured. The workflow itself has not run on GitHub yet.)
- [ ] SMS notifications and bounce handling (email over SMTP is implemented)
- [ ] Multi-instance, sustained-soak and network-latency load tests (a single-machine run is done: see operations.md)
- [ ] Content-Security-Policy for the web app; httpOnly-cookie sessions
- [ ] Separate-failure-domain backups with object-lock, key escrow rehearsal, per-backup data keys, backup/archive alerting, scheduled drill in CI (see dr-test-report.md gaps)

## Backup & restore
Full runbook: [disaster-recovery.md](disaster-recovery.md). Measured results and gaps: [dr-test-report.md](dr-test-report.md).
- Verified on a **real PostgreSQL 17 server** (local, synthetic data): encrypted base backup + encrypted WAL archive, crash recovery, PITR, restore into an empty server, corrupted/truncated/tampered backup rejection, WAL-gap detection, restore re-run, and the full existing test suite passing against the restored server. Re-run with `npm run dr:drill`.
- NOT verified: managed-cloud PostgreSQL, separate failure domains / WORM / cross-region, key escrow rehearsal, production-sized data, synchronous replication.
- After any restore money-out is frozen until provider reconciliation is clean and an admin (with MFA step-up) releases it.

## Incident response (outline)
Suspected key leak → rotate secrets, revoke tokens (change JWT secret). Suspected fraud → suspend merchant (`POST /admin/merchants/:id/status`), hold payouts, preserve audit logs. Unknown payout outcome → never resubmit manually; use `POST /admin/payouts/:id/retry`, which looks up the provider first.
