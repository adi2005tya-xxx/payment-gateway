# Multi-factor authentication (TOTP)

## What is enforced (all on the backend)
- **Every ADMIN must use MFA.** A password-only admin session can call only `/auth/*` routes; every other route returns `403 MFA_REQUIRED` (`mfa: ENROL_REQUIRED | CHALLENGE_REQUIRED`). Any user who enrols (e.g. a merchant opting in) is held to the same rule. `MFA_REQUIRED_ROLES` may add roles, but config validation refuses to drop `ADMIN`.
- **Server-side sessions.** The JWT carries a session id (`sid`). Tokens with no valid, unexpired, unrevoked session are rejected, so tokens issued before this change stop working. A session starts MFA-unverified; completing the challenge revokes it and issues a **new** session id (no session fixation). Enrolling or replacing an authenticator revokes all of that user's other sessions. Logout revokes server-side.
- **TOTP** (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step). A code is accepted at most once: the accepted time-step is stored and any code for an equal or earlier step is rejected as a replay. Attempts are row-locked, so concurrent submissions serialise.
- **Step-up** (`POST /auth/mfa/step-up`, TOTP or recovery code) opens a window (`MFA_STEPUP_WINDOW_SECONDS`, default 300 s). Routes marked high-risk return `403 STEP_UP_REQUIRED` outside it:
  payout approve/reject/retry, settlement-destination verification, merchant status change, merchant onboarding decision, refunds, payment review approval, job replay, MFA-recovery approve/reject, recovery-code regeneration, and authenticator replacement.
  A merchant who has enrolled MFA also needs step-up to add a settlement destination. Merchants without MFA are unchanged; their destinations still cannot receive payouts until an admin, with step-up, verifies them. Existing controls (dual approval, limits) still apply on top.
- **Brute force.** 5 consecutive wrong MFA codes lock the factor for 15 min and revoke the attempting session; wrong recovery codes count toward the same limit. 5 wrong passwords lock login for 15 min (the response is identical to a wrong password). Per-client route limits (`RATE_LIMIT_AUTH_PER_MIN`, `RATE_LIMIT_MFA_PER_MIN`, recovery requests 3/min) apply as well.

## Enrolment (first admin login)
1. `POST /auth/login` → `{ token, mfa: "ENROL_REQUIRED" }` (the token only works on `/auth/*`).
2. `POST /auth/mfa/enrol/start` → `{ secret, otpauthUri, qrImage }`. Scan the QR with any TOTP app (the base32 `secret` is for manual entry). It is shown only here, over TLS.
3. `POST /auth/mfa/enrol/confirm { code }` → `{ token, recoveryCodes[10] }`. **Store the recovery codes offline; they are never shown again.** The returned token is the new, verified session.

Later logins: `POST /auth/login` → `POST /auth/mfa/challenge { code }` (or `{ recoveryCode }`) → new token.

## Storage
- TOTP secret: AES-256-GCM, bound to the user id as AAD, key from `MFA_ENCRYPTION_KEY` (32 random bytes, base64). Rotation: put the old key in `MFA_ENCRYPTION_KEY_PREVIOUS`; new writes use the new key.
- Recovery codes: 10 random 50-bit codes, stored only as HMAC-SHA256 (key derived from the encryption key via HKDF), consumed with an atomic single-use update.
- Audit, alert and notification rows and logs contain method, outcome and reason only — never secrets, OTPs or recovery codes. An automated test scans everything the suite generates for them.

## Lost authenticator
1. **Has recovery codes:** sign in with one (single use), step up, then re-enrol (`enrol/start` + `confirm`) and regenerate codes. Alert `MFA_RECOVERY_CODES_LOW` fires at 2 or fewer left.
2. **No codes (controlled recovery):**
   1. The owner calls `POST /auth/mfa/recovery-request { email, password }`. It needs the password and always returns the same reply. It raises an `MFA_RECOVERY_REQUESTED` alert.
   2. A **different** administrator, with MFA and fresh step-up, verifies the person **out of band** (video call, in person), then calls `POST /admin/mfa-recovery-requests/:id/approve { note }`. The note is mandatory and audited. Self-approval is refused (also by a database constraint).
   3. Nothing changes for `MFA_RECOVERY_DELAY_HOURS` (default 24). If the real owner signs in with MFA during the delay, the request is cancelled automatically.
   4. After the delay, the owner's **next successful password login** executes the reset: authenticator and recovery codes are deleted, all sessions revoked, and they must re-enrol. Unapproved requests never reset anything, and requests expire after 72 h.
3. **No second administrator exists:** there is deliberately no API for this. Use a documented break-glass change made by two authorised people directly on the database (delete that user's `user_mfa` and `mfa_recovery_codes` rows, revoke their `auth_sessions`) and record it through change management. Keep at least two admins to avoid this.

## Operations
- Route these to on-call: alerts `MFA_LOCKOUT`, `MFA_RECOVERY_REQUESTED`, `MFA_RECOVERY_COMPLETED`, `MFA_RECOVERY_CODES_LOW`, and repeated `auth.login.failed` / `mfa.challenge.failed` audit actions.
- Keep server clocks in sync (NTP); TOTP depends on it.
- Back up `MFA_ENCRYPTION_KEY` separately from the database. Losing it makes every enrolment unreadable (users would go through recovery); a database backup alone does not expose secrets.
- Bootstrap: `BOOTSTRAP_ADMIN_*` creates the first admin, who enrols on first login. Remove those variables afterwards.

## Security assumptions and known limits
- TOTP is phishable by a real-time proxy. WebAuthn/passkeys would be stronger and are not implemented.
- Whoever holds a user's password **and** an unused recovery code, or the device, is that user. Recovery approval depends on the approving admin verifying identity out of band; code cannot check that.
- An attacker who knows an admin's password can deliberately trigger the 15-minute lockouts against them (an availability trade-off for brute-force protection).
- The encryption key lives in process environment; deliver it from a secrets manager or KMS. This is application-level encryption, not an HSM.
- Route rate-limit counters are in memory per instance; behind several instances use a shared store. Account lockouts are stored in the database and are not affected.
- A database superuser can still alter MFA tables (see the separate-DB-roles item in `security-checklist.md`).
- Merchants are not required to use MFA by default. Set `MFA_REQUIRED_ROLES=ADMIN,MERCHANT` to require it; merchants then must enrol at next login.
