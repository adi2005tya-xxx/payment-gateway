-- Phone notification / SMS forwarding as a WEAKER, clearly labelled evidence source (evidence = 'DEVICE_NOTIFICATION').
-- A forwarding device authenticates with a bearer token (only its SHA-256 is stored).

CREATE TABLE ingest_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  last_seen_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

ALTER TABLE bank_credits DROP CONSTRAINT bank_credits_evidence_check;
ALTER TABLE bank_credits ADD CONSTRAINT bank_credits_evidence_check CHECK (evidence IN ('BANK_EMAIL','MANUAL_ATTESTATION','DEVICE_NOTIFICATION'));

-- Orders whose payable amount was made unique among open orders by adding a few paise, so an alert that carries no order
-- reference can still be matched exactly. The database enforces the uniqueness (no two open orders share an amount).
ALTER TABLE payment_requests ADD COLUMN unique_amount boolean NOT NULL DEFAULT false;
ALTER TABLE payment_requests ADD COLUMN base_amount_minor bigint;
CREATE UNIQUE INDEX payment_requests_unique_pending_amount ON payment_requests(provider, amount_minor)
  WHERE unique_amount AND status IN ('PENDING','UNDER_REVIEW');
