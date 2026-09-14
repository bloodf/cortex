-- 022_agent_generator.sql
-- Agent Generator sessions (P2). Each row is one AI-driven profile-creation
-- conversation: the chosen model/reasoning, the running transcript, the
-- collected ProfileSpec, and the lifecycle status (draft → building → done|error).
--
-- CHECK constraints are inline so the migration is safe to re-run against a
-- table that already exists without the constraints (CREATE TABLE IF NOT EXISTS
-- is a no-op for an existing table; inline constraints only apply on first
-- creation, which is the intended once-per-ledger semantics).

CREATE TABLE IF NOT EXISTS agent_generator_sessions (
  id           SERIAL PRIMARY KEY,
  slug         VARCHAR(64),                                   -- target profile slug (nullable until chosen)
  status       VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','building','done','error')),
  model        VARCHAR(128) NOT NULL,
  reasoning    VARCHAR(8)  NOT NULL DEFAULT 'medium' CHECK (reasoning IN ('low','medium','high')),
  transcript   JSONB       NOT NULL DEFAULT '[]'::jsonb,       -- [{role,content,ts}]
  spec         JSONB       NOT NULL DEFAULT '{}'::jsonb,       -- collected ProfileSpec
  build_logs   TEXT        NOT NULL DEFAULT '',                -- captured buildProfileFromSpec lines
  created_by   VARCHAR(128),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_generator_sessions_status ON agent_generator_sessions (status);
CREATE INDEX IF NOT EXISTS idx_agent_generator_sessions_created_at ON agent_generator_sessions (created_at DESC);
