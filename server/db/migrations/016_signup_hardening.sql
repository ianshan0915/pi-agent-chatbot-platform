-- 1. Add email_verified to users (grandfather existing users as verified)
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
UPDATE users SET email_verified = TRUE WHERE id IS NOT NULL;
ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;

-- 2. Email verification tokens (DB-backed, survives restarts)
CREATE TABLE email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_evtoken_lookup ON email_verification_tokens(token)
  WHERE consumed_at IS NULL;

-- 3. Invite tokens (admin-generated)
CREATE TABLE invite_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID REFERENCES teams(id) NOT NULL,
  created_by  UUID REFERENCES users(id) NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  label       TEXT,
  email       TEXT,
  max_uses    INTEGER DEFAULT 1,
  use_count   INTEGER DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_invite_lookup ON invite_tokens(token)
  WHERE revoked_at IS NULL;
