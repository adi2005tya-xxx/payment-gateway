-- Gateway core schema. All money is integer minor units (paise for INR).
-- Plain PostgreSQL only (also runs on PGlite for sandbox/tests).

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN','MERCHANT')),
  merchant_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','REJECTED')),
  fee_bps integer NOT NULL DEFAULT 200 CHECK (fee_bps BETWEEN 0 AND 10000),
  settlement_hold_hours integer NOT NULL DEFAULT 0 CHECK (settlement_hold_hours >= 0),
  per_payout_limit_minor bigint NOT NULL DEFAULT 10000000 CHECK (per_payout_limit_minor > 0),
  daily_payout_limit_minor bigint NOT NULL DEFAULT 50000000 CHECK (daily_payout_limit_minor > 0),
  review_threshold_minor bigint NOT NULL DEFAULT 5000000 CHECK (review_threshold_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD CONSTRAINT users_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants(id);

CREATE TABLE merchant_verification_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','INFO_REQUIRED')),
  -- Reference into the provider-hosted KYC record. No identity documents are stored here.
  provider_kyc_ref text,
  notes text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_settlement_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  -- Provider-held token (e.g. fund account id). Raw account numbers are never stored.
  provider_destination_ref text NOT NULL,
  label text NOT NULL,
  masked_account text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','DISABLED')),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_verified_destination ON merchant_settlement_destinations(merchant_id) WHERE status = 'VERIFIED';

CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  order_reference text NOT NULL,
  description text NOT NULL DEFAULT '',
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','PENDING','PAID','EXPIRED','CANCELLED','UNDER_REVIEW')),
  provider text NOT NULL,
  provider_order_id text UNIQUE,
  public_token text NOT NULL UNIQUE,
  qr_payload text,
  expires_at timestamptz,
  is_sandbox boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, order_reference)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id uuid REFERENCES payment_requests(id),
  merchant_id uuid REFERENCES merchants(id),
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  provider_order_id text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  net_minor bigint NOT NULL DEFAULT 0,
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN
    ('CREATED','PENDING','PROCESSING','SUCCEEDED','FAILED','EXPIRED','PARTIALLY_REFUNDED','REFUNDED','REVERSED','UNDER_REVIEW')),
  verification_result text NOT NULL DEFAULT 'VERIFIED',
  eligible_at timestamptz,
  is_sandbox boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id),
  CHECK (refunded_minor <= amount_minor)
);
CREATE INDEX payments_merchant_idx ON payments(merchant_id, created_at DESC);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','FAILED','IGNORED')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE payment_events (
  id bigserial PRIMARY KEY,
  payment_request_id uuid REFERENCES payment_requests(id),
  payment_id uuid REFERENCES payments(id),
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- ledger
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('ASSET','LIABILITY','REVENUE','EXPENSE')),
  merchant_id uuid REFERENCES merchants(id),
  currency char(3) NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  ref_type text NOT NULL,
  ref_id text NOT NULL,
  currency char(3) NOT NULL,
  memo text NOT NULL DEFAULT '',
  is_sandbox boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A given business event can post a given kind of journal at most once.
  UNIQUE (kind, ref_type, ref_id)
);

CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  direction char(1) NOT NULL CHECK (direction IN ('D','C')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries(journal_id);

-- Posted journals are immutable: corrections are new compensating journals.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_journals_immutable BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every journal must balance (debits = credits) at commit time.
CREATE FUNCTION check_journal_balanced() RETURNS trigger AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction='D'),0),
         COALESCE(SUM(amount_minor) FILTER (WHERE direction='C'),0)
    INTO d, c FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF d <> c THEN
    RAISE EXCEPTION 'journal % unbalanced: debits % credits %', NEW.journal_id, d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();

-- ---------------------------------------------------------------- payouts / refunds
CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  destination_id uuid NOT NULL REFERENCES merchant_settlement_destinations(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  status text NOT NULL CHECK (status IN
    ('NOT_ELIGIBLE','ELIGIBLE','QUEUED','SUBMITTED','PROCESSING','SUCCEEDED','FAILED','RETURNED','UNDER_REVIEW')),
  idempotency_key text NOT NULL,
  provider text NOT NULL,
  provider_payout_id text,
  outcome_unknown boolean NOT NULL DEFAULT false,
  submit_attempts integer NOT NULL DEFAULT 0,
  failure_reason text,
  requested_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  is_sandbox boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);
CREATE UNIQUE INDEX payouts_provider_ref ON payouts(provider, provider_payout_id) WHERE provider_payout_id IS NOT NULL;

CREATE TABLE payout_events (
  id bigserial PRIMARY KEY,
  payout_id uuid NOT NULL REFERENCES payouts(id),
  from_status text,
  to_status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  fee_refund_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  idempotency_key text NOT NULL,
  provider_refund_id text,
  reason text NOT NULL DEFAULT '',
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, idempotency_key)
);

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WON','LOST')),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- reconciliation / risk
CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'COMPLETED',
  items_checked integer NOT NULL DEFAULT 0,
  discrepancies integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_items (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id),
  kind text NOT NULL,
  subject_ref text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  resolved boolean NOT NULL DEFAULT false
);

CREATE TABLE risk_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- reliability
CREATE TABLE idempotency_records (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Durable job queue (transactional outbox). Claimed with FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs(status, run_at);

CREATE TABLE notification_jobs (
  id bigserial PRIMARY KEY,
  merchant_id uuid REFERENCES merchants(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  subject_type text,
  subject_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
