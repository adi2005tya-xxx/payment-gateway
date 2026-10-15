# Regulatory & partner dependency checklist (must be complete before any real money)

This is an engineering checklist, **not legal advice**. Obtain advice from qualified Indian fintech counsel.

- [ ] Written funds-flow diagram approved by counsel and the partner: who receives customer funds, who holds them, who pays merchants.
- [ ] Regulatory position determined (e.g. whether the model requires the platform to be an RBI-authorised payment aggregator, or to operate strictly as a technology service on top of an authorised aggregator/bank with merchants contracted to them). **Collecting into an ordinary company/personal account and redistributing is assumed NOT permitted.**
- [ ] Written agreement with the authorised partner covering: collection model, escrow/nodal/settlement arrangement, third-party merchant payouts, sub-merchant onboarding, fees, refunds, chargebacks, data processing.
- [ ] Merchant KYC/KYB process, performed through the partner or a licensed vendor; prohibited-business list; ongoing monitoring.
- [ ] Settlement-account verification (e.g. penny-drop) via the partner.
- [ ] Refund, dispute, grievance and customer-support procedures; published grievance contact.
- [ ] Fraud/AML monitoring thresholds, escalation, record retention and reporting duties.
- [ ] Data protection: DPDP Act notices, retention, breach process; payment-data storage rules (no card data stored here).
- [ ] Security review / pentest; incident response plan; backup restore drill (see runbook in `security-checklist.md`).
- [ ] Customer-facing claims reviewed: **do not claim RBI authorisation, "bank-grade", or any certification unless independently established.**
- [ ] Limited approved pilot with caps, before general availability.

Until all boxes above are ticked, `PAYMENT_MODE=live` stays blocked in `src/common/config.ts`.
