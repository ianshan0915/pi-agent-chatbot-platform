-- Agent profiles: pre-configured specialist agents with custom system prompts
CREATE TABLE agent_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             TEXT NOT NULL CHECK (scope IN ('platform', 'team', 'user')),
  owner_id          UUID NOT NULL,           -- teamId for platform/team, userId for user
  name              TEXT NOT NULL,
  description       TEXT,
  icon              TEXT,                     -- emoji character for display

  -- Agent configuration
  system_prompt     TEXT NOT NULL,            -- injected via --system-prompt or --append-system-prompt
  prompt_mode       TEXT NOT NULL DEFAULT 'replace' CHECK (prompt_mode IN ('replace', 'append')),
  skill_ids         UUID[],                   -- curated skills to inject (null = none beyond persona)
  model_id          TEXT,                     -- preferred model (nullable, falls back to session default)
  provider          TEXT,                     -- preferred provider (nullable)

  -- UX
  starter_message   TEXT,                     -- displayed in chat on new session
  suggested_prompts TEXT[],                   -- quick-start prompt buttons

  -- Metadata
  use_count         INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(scope, owner_id, name)
);

CREATE INDEX idx_agent_profiles_scope ON agent_profiles(scope, owner_id);

-- Track which agent profile was used per session
ALTER TABLE sessions ADD COLUMN agent_profile_id UUID REFERENCES agent_profiles(id) ON DELETE SET NULL;
