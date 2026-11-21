# Custom checkout (razorpay.js): our own payment screen

The customer pays on **our** screen (`web/components/pay/`). Razorpay only processes the payment in the background through `razorpay.js`. Bank OTP / 3-D Secure pages are the bank's and always appear.

Use it with `PROVIDER_KIND=razorpay`. For any other provider, or when the API says custom checkout is unavailable for a link, the page falls back to the previous screen. A hosted fallback at `/pay/razorpay/:orderId` (Razorpay's own popup) stays available.

## How it works
1. Merchant creates a payment request (`POST /merchant/payment-requests`). **The amount comes from our database**, and the Razorpay order is created server-side with it.
2. The customer opens `/pay/<token>` on the website. The page calls `GET /public/pay/:token/checkout`, which returns `{ keyId, orderId, amountMinor, ... }`. Only the **public key id** is returned; the secret and the webhook secret never leave the server.
3. `useRazorpay()` (`web/lib/razorpay.ts`) loads `https://checkout.razorpay.com/v1/razorpay.js` from Razorpay's CDN and waits for `ready`, which lists the methods enabled on your account. Only those are shown.
4. The screen calls `razorpay.createPayment({ amount, order_id, email, contact, method, ... })`:
   - **UPI** (intent): on a phone the UPI app opens; on desktop a QR is shown in our UI with a 15-minute timer. UPI Collect is not offered.
   - **Card**: our own form (Luhn check, brand detection, formatting). Card data goes from the browser to razorpay.js only, never to our API.
   - **Net banking**: popular banks as tiles plus a searchable list.
   - **Wallets**: from the enabled list.
5. On `payment.success` the page posts `{ orderId, paymentId, signature }` to `POST /pay/razorpay/verify`. The API checks `HMAC-SHA256(order_id|payment_id, KEY_SECRET)` in constant time (400 on mismatch), captures the payment if it was only authorized, and re-reads the payment from Razorpay before crediting. That endpoint is for fast feedback only.
6. **The webhook is the source of truth** (`POST /webhooks/razorpay`): raw body, `X-Razorpay-Signature` check, duplicate events ignored, handles `payment.captured`, `payment.failed` and `order.paid`.
7. The page polls `GET /public/pay/:token` and shows PAID only when the platform's own record says so.
8. `payment.error` shows a friendly message and re-enables the form so the customer can retry on the same order.

Rate limits: the checkout-params endpoint allows 30 requests a minute and verify allows 20, per client.

## Setup
`backend/.env` (never committed): `PROVIDER_KIND=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `WEB_ORIGIN=http://localhost:3000`.
`web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:3001`. The website does not need the key id in its own env; the API supplies it.

```
cd backend && npm start        # API on :3001
cd web && npm run dev          # website on :3000
```

## Testing in test mode
- **UPI:** choose UPI, then on a phone approve in the app; on desktop use `success@razorpay` through Razorpay's test flow if your account offers it. `failure@razorpay` fails.
- **Card:** `4100 2800 0000 1007`, CVV `123`, any future expiry; choose success on the bank page.
- **Webhook locally:** `ngrok http 3001` (or `npx localtunnel --port 3001`), set `PUBLIC_BASE_URL` to the HTTPS address, and register `https://<tunnel>/webhooks/razorpay` in Razorpay (Test Mode > Webhooks) with events `payment.captured`, `payment.failed`, `order.paid` and the same secret as `RAZORPAY_WEBHOOK_SECRET`.

## Go-live checklist
- [ ] Ask Razorpay to **enable Custom Checkout** on your account (it is not on by default) and confirm any PCI-DSS requirement for accepting card details on your own form.
- [ ] Complete the platform's [regulatory checklist](regulatory-checklist.md); `PAYMENT_MODE=live` is blocked in code until it is done and the live-key guard in `razorpay.provider.ts` is deliberately relaxed.
- [ ] Switch to `rzp_live_` keys, register the **live** webhook with its own secret.
- [ ] Turn on automatic capture in the Razorpay dashboard (the API also captures after verifying, as a safety net).
- [ ] HTTPS on the website and API domains; set `WEB_ORIGIN` / `PUBLIC_BASE_URL` to them.

## Known gaps
- Not verified against Razorpay's live servers: the `razorpay.js` call and event names (`once('ready')`, `createPayment`, `payment.success`, `payment.error`, `payment.upi.intent_response`) are written from Razorpay's documentation and need a real test payment. If UPI never returns a link, the screen says so after 10 seconds and offers the hosted page.
- Desktop UPI QR depends on razorpay.js returning a UPI link for the intent flow. If your account does not, the alternative is Razorpay's server-side QR Codes API (not built).
- The screens have no automated browser tests yet; the API side has tests (`backend/test/gateways.spec.ts`).
