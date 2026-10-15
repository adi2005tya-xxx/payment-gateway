# Operations: notifications, alerts, password reset, monitoring, load

## Notifications
Queued in `notification_jobs` inside the same transaction as the event. The worker (every 30 s) delivers them: at-least-once, leased with `SKIP LOCKED`, exponential backoff, `FAILED` after 8 attempts, `SKIPPED` when nobody can receive it.
Config: `SMTP_URL` (e.g. `smtps://user:pass@host:465`) and `MAIL_FROM`; with no `SMTP_URL` messages are only logged as `kind -> masked recipient` (never the body). Kinds: payment received, settlement completed/failed, refund processed, MFA recovery approved, password reset. Messages contain amounts, masked destinations and ids, never secrets; **the raw UPI ID never appears** (tested). Not built: SMS, per-merchant webhooks, templates/localisation, bounce handling.

## Password reset
`POST /auth/password-reset/request` always answers the same way. For an active account it stores only a **hash** of a 256-bit single-use token (30 min), invalidates older tokens, allows 3 requests/hour/account, and queues an email whose link token is held **encrypted** in the queue row and scrubbed after sending. `confirm` sets the password, clears lockouts and **revokes every session**. It never turns MFA off: an administrator still needs the second factor after a reset (tested).

## Alert routing
Alerts are rows in `alerts`. `ALERT_WEBHOOK_URL` (Slack-compatible incoming webhook or any JSON endpoint; optional `ALERT_WEBHOOK_SECRET` adds an `x-gateway-signature` HMAC) receives `warning` and `critical` alerts; failures are retried on the next tick (up to 10 tries). Severity map: `src/ops/alerts.ts`.
`OpsMonitor` (every 5 minutes) raises, once per hour per kind: `JOBS_LATE`, `WEBHOOK_BACKLOG`, `PAYOUTS_STUCK`, `LEDGER_UNBALANCED`, and hourly `AUDIT_CHAIN_BROKEN`. Existing event alerts include `PAYOUT_UNKNOWN_OUTCOME`, `RECONCILIATION_DISCREPANCY`, `MONEY_OUT_FROZEN`, `PROVIDER_BALANCE_LOW`, `WEBHOOK_SIGNATURE_FAILURE`, `MFA_LOCKOUT`. **Not built:** paging/escalation policy, on-call routing, backup-age and archive-failure alerts (the database host must report those), metrics export.

## Large payouts
A payout above the provider's per-transaction cap (`payoutLimitMinor`; UPI default INR 1,00,000, configurable) is split into a group of transfers (`<key>#0`, `#1`…). Each part is reserved, sent, confirmed and reconciled separately; review and approval apply to the whole request; the request is idempotent as a whole. If the owner account cannot fund a part, that part waits (QUEUED, one `PROVIDER_BALANCE_LOW` alert) and nothing is sent.

## Adopting orphan payouts
See the disaster-recovery runbook, step 9. Two administrators (propose, then apply), amount and status taken from the provider, audited, posts the same reserve/complete journals.

## Load and capacity (measured, real PostgreSQL 17, one Windows machine, simulated bank)
`npx ts-node scripts/load-test.ts 3000 30 32 12` against `scripts/pg-scratch.ts start`. Results: [load-test-results.json](load-test-results.json).

| Phase | Result |
|---|---|
| Payment request + webhook ingest (32 concurrent clients) | ~313 per second; p50 97 ms, p95 143 ms, p99 253 ms |
| Verification (12 competing workers: provider lookup, matching, atomic ledger post) | ~135 per second |
| Payouts (30 merchants x 3 simultaneous identical requests) | exactly 30 created and 30 settled |
| Correctness under load | 0 duplicate journals, all 18 integrity invariants hold, 0 reconciliation discrepancies |

Findings: verification throughput stays flat as workers increase (8 -> 12), so it is bounded by something shared. An experiment that removed the audit-log write from verification raised it from ~136 to ~181 per second, so the **global audit-chain lock accounts for roughly a quarter of the cost**; the rest is per-payment query count, commit latency and one Node process. These numbers are for this machine and a database on the same host; they are **not** a capacity guarantee, and no multi-instance, network-latency, or sustained-soak test was run. If higher throughput is needed, first options: batch audit writes per transaction, fewer round trips per verification, more instances.
