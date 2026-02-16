-- Phase 3: Skills and file uploads

CREATE TABLE skills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       TEXT NOT NULL CHECK (scope IN ('platform','team','user')),
  owner_id    UUID NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(scope, owner_id, name)
);

CREATE TABLE user_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   BIGINT,
  storage_key  TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_user_files_user ON user_files(user_id, created_at DESC);
