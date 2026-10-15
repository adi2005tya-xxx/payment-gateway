# Automatic UPI payment confirmation from bank credit emails (`PROVIDER_KIND=bank-email`)

> **What this is, honestly.** It treats a *DKIM-signed email from your bank's own domain* as evidence that a credit arrived. It is **not** a bank API, **not** a statement reconciliation, and **not** bank-level verification. Email can be delayed, lost, or (for a bank that does not sign mail) unverifiable. Anything important should still be checked against the bank statement. This mode stays in sandbox: **payouts, refunds and merchant settlement are disabled**, and `PAYMENT_MODE=live` remains blocked.

## What you get
1. Enter **your UPI ID** and an **amount** → a scannable UPI QR whose link carries a **unique order id** (`GW` + 10 characters, in the UPI `tr`/`tn` fields).
2. The bank's credit alert arrives in your Gmail → the system verifies it, extracts **amount, bank transaction reference, and credit time**, and matches it to a pending order.
3. The order becomes **PAID** only through the existing verification engine (exact amount, order state, atomic ledger entry) and only from a **verified bank alert**. Screenshots, browser redirects and "I paid" clicks are never evidence.
4. Anything missing, delayed, unmatched or ambiguous leaves the order **PENDING** (or holds the money in suspense) with a manual-review path.
5. Dashboard: **Pending, Paid, Expired, Unmatched** (+ Needs review) at `/admin/collections`; mailbox and templates at `/admin/mailbox`.

## You must supply your bank's real alert format
**No bank's email format is built in or guessed.** You describe it as a *template* (sender address, DKIM domain, a regex that recognises a credit, regexes for amount, bank reference and timestamp, the timestamp format). The system will not trust any email until a template is **active**, and a template can only be activated after it has parsed a **real sample alert you provide**.

How to build yours:
1. In your mail client, open a real credit alert → "Show original" / "Download message" (`.eml`). Note the exact `From:` address and the `d=` domain in the `DKIM-Signature:` header.
2. `/admin/mailbox` → **New template**. Fill the fields (regexes run on the text with line breaks collapsed to single spaces; the value goes in capture group 1). Paste the alert text and press **Test on this sample**: it shows the amount, reference and time it extracted. Check them against the email by eye.
3. Save, then **Validate with a real sample** (you attest it is genuine), then **Activate**.
4. Upload the original `.eml` under **Test with a saved email**: it goes through the *full* pipeline including the DKIM check against your bank's published key.
5. If the bank puts the UPI reference/remark (our order id) in the alert, matching is automatic. If it does **not**, see "Matching" below.

If your bank's alert emails are **not DKIM-signed**, or the signing domain does not match the From domain, this integration cannot authenticate them and will reject them (`AUTH_FAILED`). Do not work around that.

## Connect Gmail (no password, read-only)
1. In Google Cloud Console create an **OAuth client** (Web application) with redirect URI `https://<your-api>/auth/google/callback`. Enable the Gmail API. Request only `https://www.googleapis.com/auth/gmail.readonly`.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `PROVIDER_KIND=bank-email` (see `backend/.env.example`).
3. `/admin/mailbox` → **Connect Gmail** → sign in at Google and approve. The app **never sees your mailbox password**. It uses OAuth 2.0 with PKCE; a one-time state bound to the admin who started the flow authorises the callback; broader scopes than read-only are **refused**.
4. The refresh token is stored **AES-256-GCM encrypted** (key `MFA_ENCRYPTION_KEY`) and never logged. **Disconnect** revokes it at Google and deletes it locally.
5. Sync runs every `MAIL_SYNC_INTERVAL_SECONDS` (default 60), only requests mail **from your template's sender address(es)**, and does not read the mailbox at all when no template is active. Failures retry with exponential backoff; repeated failures raise `MAILBOX_SYNC_FAILING`; a revoked authorisation raises it with `REAUTH_REQUIRED`.

Sandbox/dev alternative: `MAIL_FOLDER_DIR=<folder>` reads saved `.eml` files instead of Gmail (same authenticity checks).

## How an alert becomes evidence (every step must pass)
| Check | Rejects |
|---|---|
| Single `From` address on the template's **allowlist** | spoofed display names, lookalike domains, forwarded copies from a customer |
| **DKIM verified cryptographically** against the signing domain's DNS key (the library recomputes the signature; the text of `Authentication-Results` is never trusted) | unsigned mail, altered bodies, forged headers, mail signed by someone else |
| Signing domain on the template's allowlist **and equal to or a parent of the From domain** | valid signatures by an attacker's own domain |
| Signature **covers the From header** and has **no body-length limit (`l=`)** | signatures that let content be appended or From be swapped |
| Template parses **every** field; it is a **credit** (not debit/reversal/failed) | partial or ambiguous alerts: they become `UNPARSEABLE` with an alert, never a guess |
| Credit time **not later than the email's receipt time** (Gmail's own clock) and **not older than `ALERT_MAX_AGE_HOURS`** | impossible timestamps and replayed old emails |
| **Bank reference unique**, content hash unique, message id unique | duplicate alerts: one credit, one payment, one notification |

## Matching to an order
Default policy `MATCH_POLICY=reference_required` (safest): the alert text must contain the order id **and** the amount must equal the order **exactly** (integer paise) **and** the credit time must fall inside the order's window (`created − 2 min … expires`). The engine re-checks amount and state.
- Wrong amount (under/over/off by one paisa) → `REVIEW`, order `UNDER_REVIEW`, money booked to **suspense**, never to the merchant.
- Order id not found / two order ids / amount right but no order id → `UNMATCHED`/`AMBIGUOUS`, money in suspense, shown under **Unmatched**.
- Second credit for an order already paid → held (`DUPLICATE_PAYMENT_FOR_ORDER`).
- Credit outside the order's window → held (`CREDIT_TIME_OUTSIDE_ORDER_WINDOW`).

If your bank does **not** echo the UPI note/reference, nothing can match by reference and everything lands in Unmatched. The weaker opt-in `MATCH_POLICY=unique_amount_window` then accepts **exactly one** pending order with that exact amount whose window contains the credit; several candidates are ambiguous. **Risk:** an unrelated credit of the same amount inside the window would confirm that order. Use unique amounts or short windows if you enable it.

## Delayed, missing, ambiguous
- **Delayed alert:** the credit time (not the email time) is judged against the order window, so a late email still confirms a PENDING order. Unpaid orders stay PENDING for `ORDER_GRACE_MINUTES` (default 60) after expiry for this reason, then become **EXPIRED**. A genuine alert after that is held for review and a reviewer can assign it (exact amount only).
- **Missing alert:** the order is never marked paid. After expiry it can be resolved only by a **manual attestation**: administrator A records the bank reference and time from the bank statement, administrator B approves (MFA step-up each). It is labelled `MANUAL_ATTESTED` and shown separately; it is not bank-email evidence. If the real alert shows up later with the same reference it cannot double-credit.
- **Ambiguous/unmatched credits:** reviewers can **assign** (exact amount only, with a written reason) or **dismiss**. All actions are audited.

## Secrets, audit, retries
No secret or password is requested. Stored alert text is encrypted and shown masked (viewing it is audited). Audit log entries: connect/disconnect, template create/validate/activate, auth failures, credits recorded/matched/held, manual assign/dismiss/attestation. Alerts: `BANK_EMAIL_AUTH_FAILURE` (forgery of your bank's address), `BANK_EMAIL_UNPARSEABLE`, `BANK_EMAIL_SUSPICIOUS`, `BANK_CREDIT_NEEDS_REVIEW`, `MAILBOX_SYNC_FAILING`, `BANK_EMAIL_PROCESSING_FAILED`. A message whose processing fails is retried with backoff and a half-processed credit is finished by a sweeper, never duplicated.

## What was and was not verified
- **Verified by automated tests (115):** parsing, DKIM acceptance/rejection (unsigned, altered, attacker-signed, forged headers, missing key, no-From signature, body-length limit, lookalike and forwarded senders), duplicates (same message, same content, same reference, concurrent delivery, notifications), wrong amounts, delayed/missing/early/future/old alerts, ambiguity, manual review and dual control, template gating, retry, OAuth/PKCE/state handling and the Gmail sync loop against a **mock** Google server, and the UI in a real browser. Removing each authenticity guard makes its test fail.
- **All bank emails in tests are synthetic** ("TestBank" is invented). They prove the logic, **not that your bank's real alerts will parse or authenticate**: that needs your sample.
- **Not tested:** the real Gmail/Google endpoints (no credentials available), any real bank's email, DNS DKIM lookups against real banks, mailbox volume, Gmail API quota behaviour.
- Found while testing: the DKIM *signing* library occasionally emits an invalid signature (~0.25% of messages) while the verifier is correct; test fixtures verify themselves and re-sign. This affects only test fixtures.

## Known limits
Email is not guaranteed delivery; a bank may change its alert wording (alerts `UNPARSEABLE` will tell you); only Gmail (read-only OAuth) and a dev folder source exist (no IMAP, to avoid app-password handling); one mailbox; credits are matched by order id or amount, not by payer identity; refunds and settlement are out of scope in this mode; the customer's UPI app may drop the note, which is why matching falls back to review.
