# Confirming payments from phone notifications

Use this when your bank/payment app only sends a **notification or SMS to your phone** (no email). It is a second, **weaker** evidence route next to [signed bank emails](bank-email.md).

## What it proves, and what it does not

| | Signed bank email | Phone notification |
|---|---|---|
| Cryptographic proof it came from the bank | Yes (DKIM) | **No** |
| Can the server tell it from a forgery? | Yes | **No.** The text is plain; the server trusts the device that forwards it |
| Order id inside the message | Yes (in the UPI note) | No. Matched by **exact unique amount** |
| Evidence label | `BANK_EMAIL` | `DEVICE_NOTIFICATION` ("Phone notification (unverified)") |

If the phone or the device token is compromised, someone can make the system believe a payment arrived, **up to the caps below**. That risk is accepted knowingly and bounded, not removed.

## Controls

1. **Per-device bearer token** (`gwd_...`, 256 random bits). Shown once; only its SHA-256 is stored. Revocable instantly; creating/revoking needs admin + fresh MFA and is audited. Wrong, missing or revoked token returns an identical 401.
2. **Trusted-app allowlist.** A template names the app package (or SMS sender id). A notification from any other source is recorded as `UNTRUSTED_SENDER` and never used. The package name is stated by the forwarding app, so it identifies the source only as far as you trust your phone.
3. **Real-sample template.** No format is built in. A template is activated only after it parses a real notification you paste in. Refund/failed/reversal/debit words make a message "not a credit".
4. **Freshness.** A notification whose post time is older than `DEVICE_MAX_AGE_MINUTES` (default 10) or in the future is rejected, so old notifications cannot be replayed.
5. **Duplicates.** Identical text is applied once; the same transaction id in different words is a `DUPLICATE`.
6. **Unique amounts.** Create orders with *Unique amount*. The system adds 1-99 paise so that no two open orders share a payable amount (enforced by a database unique index, not just application code). The customer must pay exactly the shown amount (e.g. ₹10.01 not ₹10.00). A credit matches only if **exactly one** open order has that exact amount inside its time window. Otherwise it is held (ambiguous/unmatched) and the money sits in suspense.
7. **Caps.** A credit above `DEVICE_AUTO_CONFIRM_MAX_MINOR` (default ₹500), or one that would push auto-confirmed phone credits past `DEVICE_DAILY_AUTO_LIMIT_MINOR` (default ₹5,000) in a rolling 24 hours, is **held for review** instead of confirming the order. A reviewer can assign it to the order (exact amount only).
8. **No payouts.** Settlements and refunds stay disabled in this mode; `PAYMENT_MODE=live` remains blocked.

## Limits you should know about

- **Only two real notification texts have been seen**, both PhonePe Business push notifications (not SMS; no SMS arrives for these payments): *You've received Rs 10 from ******0696 via PhonePe for txn T2610132007529301256970.* and *You've received Rs 1.1 from ******0696 via PhonePe for txn T2610141213300329890819.* The second shows that **a trailing zero is dropped: ₹1.10 is displayed as "Rs 1.1"** (and ₹10.00 as "Rs 10"); the parser reads "1.1" as 110 paise and this is tested. How PhonePe words refunds or failures is **not known**; those tests use synthetic wording. Send a real refund/failed notification if you ever receive one.
- A third real notification (*Rs 2.3*) was displayed in a different digit style, which may be special Unicode digits (such as double-struck). The parser folds notification text to ordinary characters (Unicode NFKC) before matching, and this is tested. I could not tell from a screenshot whether the characters are really special; the forwarded text will show.
- The transaction id in that sample has no known timestamp, so the credit time is the time the notification **arrived**.
- The server cannot confirm money reached your bank account. Check your bank statement regularly; reconcile any held or suspicious items.
- A customer who pays a *different* amount will not match; the credit shows up as `UNMATCHED` for you to assign or refund by hand.
- If the phone is off, offline, or the OS kills the forwarding app, orders stay pending. There is no delivery guarantee.
- **The Android side is not built or tested here.** It is done with an automation app (Tasker, MacroDroid or similar). The names of the variables that hold the notification title/text/package differ by app and version; check them inside the app. Do not copy variable names from anywhere without confirming them.

## Endpoint

`POST /ingest/notification` (rate limited, 60 requests/minute per client)

```
Authorization: Bearer gwd_...
Content-Type: application/json

{ "package": "com.phonepe.business",   // or "sender": "<SMS sender id>"
  "title": "Received Rs 10",
  "text": "You've received Rs 10 from ******0696 via PhonePe for txn T...",
  "postedAt": 1760000000000 }           // epoch milliseconds
```

Response `201 { "status": "CREDIT_RECORDED" | "ALREADY_SEEN" | "DUPLICATE" | "IGNORED" | "UNTRUSTED_SENDER" | "REJECTED" | "UNPARSEABLE", "reason": "..." }`. Invalid body: 400. Bad token: 401.

## Setup

1. Admin → **Phone notifications** → Add device; copy the token.
2. Create a notification template with the trusted package and expressions; test it on a real notification; validate; activate.
3. Configure the phone automation to POST each payment notification as above (test with the curl command on that page).
4. Collections → create orders with **Unique amount** ticked; show the customer the adjusted amount.

## Configuration

`DEVICE_AUTO_CONFIRM_MAX_MINOR`, `DEVICE_DAILY_AUTO_LIMIT_MINOR`, `DEVICE_MAX_AGE_MINUTES` (see `.env.example`). The template also has its own `maxAmountMinor` ceiling, above which a message is rejected outright.
