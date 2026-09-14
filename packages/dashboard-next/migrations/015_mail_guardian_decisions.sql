CREATE TABLE mail_guardian_decisions (
  id BIGSERIAL PRIMARY KEY,
  account_slug TEXT NOT NULL,
  message_uid BIGINT NOT NULL,
  from_hash TEXT NOT NULL,
  domain_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  heuristic_score INT NOT NULL DEFAULT 0,
  model TEXT,
  verdict TEXT,
  confidence REAL,
  reasons JSONB NOT NULL DEFAULT '[]',
  risk_signals JSONB NOT NULL DEFAULT '[]',
  verify_model TEXT,
  verify_verdict TEXT,
  verify_confidence REAL,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('auto_trashed','kept','pending','owner_spam','owner_keep','owner_block','owner_allow')),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_slug, message_uid)
);
CREATE INDEX mail_guardian_decisions_created_at_idx ON mail_guardian_decisions (created_at DESC);
INSERT INTO migrations (name) VALUES ('015_mail_guardian_decisions') ON CONFLICT DO NOTHING;
