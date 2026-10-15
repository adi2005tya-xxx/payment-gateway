# Web dashboards (`web/`)

Next.js 16 (App Router) + React 19 + Tailwind. Three audiences, one API:

| Area | Routes | Notes |
|---|---|---|
| Public | `/login` `/register` `/forgot-password` `/reset-password` `/mfa-recovery` | Login handles the three MFA states: not required, **enrol** (QR, manual key, confirm code, one-time recovery codes) and **challenge** (authenticator code or recovery code). |
| Customer | `/pay/[token]` | Merchant name, exact amount, QR + "Pay with your UPI app" deep link, auto-refresh. Shows "paid" only after the platform verified the credit; the sandbox shows simulate buttons. Exposes no internal ids. |
| Merchant | `/merchant` overview, `/payments`, `/requests`, `/settlements`, `/account` | Overview separates gross collections, fees, payable, available, in-flight and settled. Payment requests: create, QR/link, cancel. Payouts use a per-form idempotency key. UPI ID registration shows only the masked ID. CSV export. MFA opt-in. |
| Admin | `/admin` overview, `/merchants`, `/destinations`, `/payments`, `/payouts`, `/reviews`, `/reconciliation`, `/recovery`, `/audit`, `/security` | Name-match warnings and explicit confirmation on destinations; held-payment approval and refunds; dual-control payout approval; reconciliation; restore controls (freeze/release, held payouts, orphan-payout adoption, MFA recovery requests); audit log and alerts. |

## Behaviour worth knowing
- **Step-up is automatic.** When the API answers `STEP_UP_REQUIRED` the client opens a "Confirm it's you" dialog, verifies a fresh code and repeats the request once. Nothing in the UI is the enforcement point: every rule is enforced by the API.
- **Token storage:** `sessionStorage` (cleared when the tab closes). Any script running on the site's origin could read it, so the site sends `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and renders no untrusted HTML. An httpOnly-cookie session would be stronger but needs a same-site proxy design; not built.
- **CORS:** the API only accepts the browser origin in `WEB_ORIGIN`. Set `NEXT_PUBLIC_API_URL` at build time.
- **No Content-Security-Policy header yet** (Next's inline scripts need a nonce setup). Listed as a gap.

## Run
```bash
# API (backend/.env): PROVIDER_KIND=owner-account-sandbox, WEB_ORIGIN=http://localhost:3000, WEB_BASE_URL=http://localhost:3000,
#   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, plus the secrets from backend/.env.example
cd backend && npm start
# Web
cd web && cp .env.example .env.local && npm install && npm run build && npm start   # http://localhost:3000
```
The first admin sign-in walks through authenticator enrolment.

## Verified how
`npm run typecheck`, `npm run build`, and `npm run e2e` (needs the API and web running; `web/e2e/start-api.ps1` starts a throwaway API): a headless-Chromium script drives the real UI against the real API through admin enrolment, merchant registration, approval, UPI registration with name mismatch and step-up, payment request, customer payment, payout and the admin dashboards: 12 steps, all passing at the time of writing. It found and fixed a real defect (an optional notes field was marked required). **Not tested:** other browsers, screen readers, small-screen layouts beyond the customer page, long-lived sessions, concurrency in the UI.
