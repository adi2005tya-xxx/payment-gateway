-- Payout groups (large payouts split to fit the UPI per-transaction limit), payer info, notification delivery, alert routing,
-- password reset, and adoption of provider payouts that a restored database has no record of.
ALTER TABLE payouts ADD COLUMN payout_group uuid;
CREATE INDEX payouts_group_idx ON payouts(payout_group) WHERE payout_group IS NOT NULL;

ALTER TABLE payments ADD COLUMN payer_masked text;

ALTER TABLE notification_jobs
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN last_error text;

ALTER TABLE alerts ADD COLUMN routed_at timestamptz, ADD COLUMN route_attempts integer NOT NULL DEFAULT 0;

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_payout_id text NOT NULL,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  note text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPLIED','REJECTED')),
  proposed_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  payout_id uuid REFERENCES payouts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE UNIQUE INDEX one_open_adoption ON recovery_adoptions(provider, provider_payout_id) WHERE status IN ('PROPOSED','APPLIED');
