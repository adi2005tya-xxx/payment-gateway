## What the drill found (and fixed)
Running against a real server surfaced defects that the in-process test database had hidden:

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | `PgDb`: when PostgreSQL crashed/restarted, the pool's unhandled `error` event **killed the whole application process** | High | Pool and per-transaction client error handlers; broken connections are discarded, work is retried by the job queue |
| 2 | Event-listener leak on pooled clients (one listener added per transaction) | Low | Listener removed in `finally` |
| 3 | Backup container stored only files; **a restored PostgreSQL data directory could not start** (empty dirs such as `pg_notify`, `pg_wal` were lost) | High (backup would have been unusable) | Container records directories; regression test added |
| 4 | Payout eligibility compared the database's timestamp with the app server's clock: a payout requested milliseconds after a payment was wrongly treated as still in the settlement hold (failed the existing suite on real PostgreSQL) | Medium (also a production clock-skew hazard) | Compare using the database clock unless a test passes its own |
| 5 | Restore design gap: restoring an older backup resurrects revoked sessions, un-ages used recovery codes, shows overstated balances, and re-queues payouts the provider already executed | High | Money-out freeze, restore auto-detection (database incarnation), post-restore procedure, provider-evidence-only resolution, gated release (see runbook) |
| 6 | `rename()` of the extracted directory fails intermittently on Windows (EPERM) | Low | Retry + copy fallback |

The remaining failures along the way were bugs in the drill script itself (wrong WAL segment awaited, timezone offset truncated to hours in the PITR target, schema reference taken from a different engine, harness timing). They are not product defects.

## Gaps and limits (not fixed; do not treat disaster recovery as production-proven)
1. **Real production infrastructure is untested.** No managed PostgreSQL (RDS/Cloud SQL/Azure), no `pg_dump`/`pg_restore`, no replication. The drill used a local PostgreSQL 17 on one Windows machine and a ~35 MiB synthetic database; times will not scale linearly.
2. **Backups and WAL sit on the same disk as the test cluster.** Separate failure domains, cross-region copies, object-lock/WORM and a separate-account delete policy are **recommendations, not tested**. No claim of regional-failure or ransomware resistance is made.
3. **Key custody is simulated** with key files in a separate directory. The two-custodian offline escrow, KMS use, rotation and "restore using only escrow" are written down but **never rehearsed**. A single key protects all backups (no per-backup data keys, so no crypto-shredding of individual backups).
4. **RPO is bounded by WAL archiving.** The drill proved a committed batch that had not been archived was lost when the primary was destroyed. Near-zero RPO requires synchronous replication (not configured). Archive failure alerting and "backup too old" alerting do **not** exist yet.
5. **Orphan provider payouts (provider paid, restored DB has no record):** the system detects them and blocks release of the freeze. An adoption procedure now exists (two administrators, amount and status taken from the provider, audited; see operations.md) and is covered by tests, but it has **not** been exercised in the real-PostgreSQL drill, which pre-dates it.
6. **Provider dependence.** Restore logic relies on the provider supporting payout lookup by our reference, payout and refund idempotency keys, and listing payments. This was verified only against the sandbox provider; a real provider adapter must be tested against the same scenarios. `confirmed_not_sent` additionally relies on a human attesting that statements show no transfer.
7. **MFA after restore:** recovery codes consumed after the backup point become valid again and the TOTP replay marker is older; sessions are revoked, but admins must regenerate recovery codes (runbook step 11). Not automated.
8. **`idempotency_records` table is unused by the application** (idempotency is enforced by unique keys on payouts, refunds, webhook events and journals). The drill preserves and verifies the table and the real keys, but the table itself provides no protection today.
9. **Not automated:** the WAL-continuity and backup-checksum checks run in the drill script, not on a schedule; the monthly drill is not in CI (it needs the PostgreSQL binaries and ~2.5 minutes); only Windows was exercised.
10. **PGlite vs PostgreSQL:** the fast regression suite (`test/recovery.spec.ts`) runs on PGlite; the real-engine evidence is the drill. Both are needed.

## Recommendations (priority order)
1. Run this drill (or its managed-service equivalent) against the real production topology before go-live, and monthly after; record measured RTO on production-sized data.
2. Store backups/WAL in a separate account/region with WORM retention; give the archive writer append-only rights; alert on archive failures, WAL gaps and backup age.
3. Build and test the key escrow procedure; move to per-backup data keys wrapped by KMS.
4. ~~Build the orphan-payout adoption procedure~~ Done (see gap 5); add it to the drill.
5. Evaluate synchronous replication if the business RPO is below the archive interval.
6. Re-run the post-restore scenarios against the real provider adapter in its sandbox.
7. Add the drill to CI/nightly (with the PostgreSQL binaries) and wire its checks into alerts.
