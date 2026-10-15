-- Disaster-recovery support: durable system flags (e.g. the money-out freeze applied after a restore).
CREATE TABLE system_flags (
  key text PRIMARY KEY,
  value text NOT NULL,
  reason text NOT NULL DEFAULT '',
  set_by uuid REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);
