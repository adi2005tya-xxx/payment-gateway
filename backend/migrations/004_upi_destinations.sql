-- UPI beneficiaries: what the bank returned for the UPI ID, so an admin can compare it with the merchant's legal name.
ALTER TABLE merchant_settlement_destinations
  ADD COLUMN beneficiary_kind text NOT NULL DEFAULT 'ACCOUNT' CHECK (beneficiary_kind IN ('ACCOUNT','UPI')),
  ADD COLUMN beneficiary_name text;
