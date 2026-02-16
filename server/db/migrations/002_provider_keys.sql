-- Phase 2: Provider keys with envelope encryption + audit log

CREATE TABLE provider_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID REFERENCES teams(id) NOT NULL,
  provider        TEXT NOT NULL,
  encrypted_dek   BYTEA NOT NULL,
  encrypted_key   BYTEA NOT NULL,
  iv              BYTEA NOT NULL,
  key_version     INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(team_id, provider)
);

CREATE TABLE provider_key_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL,
  user_id     UUID NOT NULL,
  provider    TEXT NOT NULL,
  action      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_key_audit_team ON provider_key_audit_log(team_id, created_at);
