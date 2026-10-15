-- MFA (TOTP), server-side sessions, account lockout and controlled MFA recovery.

ALTER TABLE users
  ADD COLUMN failed_logins integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  -- AES-256-GCM envelopes ("v1.<keyid>.<iv>.<tag>.<ct>"), never plaintext.
  secret_enc text,
  pending_secret_enc text,
  enrolled_at timestamptz,
  -- Highest TOTP time-step already accepted; a code for a step <= this is a replay.
  last_used_step bigint NOT NULL DEFAULT 0,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  -- Keyed hash (HMAC-SHA256) of the code; the code itself is shown once and never stored.
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  -- NULL until a second factor has been verified on THIS session.
  mfa_verified_at timestamptz,
  -- Last time a factor was (re)verified; high-risk routes require this to be recent.
  stepup_at timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE mfa_recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','APPROVED','REJECTED','COMPLETED','CANCELLED','EXPIRED')),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  decision_note text,
  -- MFA is reset no earlier than this; gives the real owner time to notice and cancel.
  execute_after timestamptz,
  completed_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> user_id)
);
CREATE UNIQUE INDEX one_open_recovery_request ON mfa_recovery_requests(user_id) WHERE status IN ('REQUESTED','APPROVED');
