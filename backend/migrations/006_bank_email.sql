-- Automatic payment confirmation from bank credit alert emails (provider kind "bank-email").
-- Evidence model: an order is PAID only from a bank_credits row that came from an authenticated email (DKIM-verified,
-- allowlisted sender, template-parsed) or from a dual-controlled manual attestation that is labelled as such.

ALTER TABLE payment_requests ADD COLUMN payee_vpa text;

CREATE TABLE mailbox_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'gmail',
  email text NOT NULL,
  -- OAuth refresh token, AES-256-GCM encrypted. The mailbox password is never requested or stored.
  refresh_token_enc text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED','ERROR','DISCONNECTED')),
  last_sync_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  connected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_mailbox ON mailbox_connections ((true)) WHERE status <> 'DISCONNECTED';

CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  code_verifier_enc text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE alert_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  bank_name text NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','DISABLED')),
  -- Set when a REAL sample email parsed successfully with this definition. A template cannot be activated without it.
  validated_at timestamptz,
  validated_sample_hash text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_message_id text NOT NULL,
  content_hash text NOT NULL,
  received_at timestamptz NOT NULL,
  from_addr text,
  subject text,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN
    ('RECEIVED','IGNORED','UNTRUSTED_SENDER','AUTH_FAILED','UNPARSEABLE','REJECTED','DUPLICATE','CREDIT_RECORDED','ERROR')),
  reason text,
  template_id uuid REFERENCES alert_templates(id),
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  -- bounded, normalised alert text, encrypted (it can contain payer details); shown masked to reviewers
  body_enc text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (source, source_message_id)
);
CREATE INDEX mail_messages_hash_idx ON mail_messages(content_hash);

CREATE TABLE bank_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  credited_at timestamptz NOT NULL,
  payer_masked text,
  order_tokens text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','MATCHED','UNMATCHED','AMBIGUOUS','REVIEW','DISMISSED')),
  reason text,
  match_method text,
  order_id uuid REFERENCES payment_requests(id),
  payment_id uuid REFERENCES payments(id),
  candidates jsonb NOT NULL DEFAULT '[]',
  evidence text NOT NULL CHECK (evidence IN ('BANK_EMAIL','MANUAL_ATTESTATION')),
  source_message_id uuid REFERENCES mail_messages(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_credits_status_idx ON bank_credits(status);

CREATE TABLE manual_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES payment_requests(id),
  reference text NOT NULL,
  credited_at timestamptz NOT NULL,
  note text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPLIED','REJECTED')),
  proposed_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE UNIQUE INDEX one_open_attestation ON manual_attestations(order_id) WHERE status = 'PROPOSED';
