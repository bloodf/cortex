-- Migration 011: Mail Guardian schema.
--
-- Creates ALL mail_guardian_* tables so a fresh dashboard database has them
-- even before the cortex-mail-guardian backend service runs its own
-- CREATE TABLE IF NOT EXISTS bootstrap. Shapes match the live backend tables
-- exactly (reviews / actions / processed / rules) and add the new
-- mail_guardian_accounts table that backs the dashboard account-management UI.
--
-- Fully idempotent: every statement uses IF NOT EXISTS, so re-applying against
-- a database where the backend already created these tables is a no-op (only
-- the trailing migrations bookkeeping insert has any effect).

-- ---------------------------------------------------------------------------
-- Reviews: one row per message that needed an owner decision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_guardian_reviews (
  id BIGSERIAL PRIMARY KEY,
  account_slug TEXT NOT NULL,
  message_uid BIGINT NOT NULL,
  message_id TEXT,
  from_hash TEXT NOT NULL,
  domain_hash TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  model_verdict TEXT NOT NULL,
  model_confidence NUMERIC(5,4) NOT NULL,
  owner_decision TEXT CHECK (owner_decision IS NULL OR owner_decision IN ('spam','keep','block_sender','allow_sender')),
  approver TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (account_slug, message_uid)
);

CREATE INDEX IF NOT EXISTS idx_mail_guardian_reviews_open
  ON mail_guardian_reviews (requested_at DESC)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Actions: queued owner decisions the backend applies on its next sweep.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_guardian_actions (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES mail_guardian_reviews(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('spam','keep','block_sender','allow_sender')),
  approver TEXT NOT NULL DEFAULT 'dashboard',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mail_guardian_actions_pending
  ON mail_guardian_actions (requested_at, id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Processed: idempotency ledger of every message the backend has seen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_guardian_processed (
  id BIGSERIAL PRIMARY KEY,
  account_slug TEXT NOT NULL,
  message_uid BIGINT NOT NULL,
  message_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('trashed','would_trash','pending_review','kept','skipped')),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_slug, message_uid)
);

CREATE INDEX IF NOT EXISTS idx_mail_guardian_processed_account
  ON mail_guardian_processed (account_slug, processed_at DESC);

-- ---------------------------------------------------------------------------
-- Rules: deterministic allow/block pre-filter (hash-based, by sender/domain).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_guardian_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('allow','block')),
  scope TEXT NOT NULL CHECK (scope IN ('sender','domain')),
  value_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_type, scope, value_hash)
);

-- ---------------------------------------------------------------------------
-- Accounts: monitored IMAP mailboxes managed from the dashboard. DB rows take
-- precedence (by slug) over MAIL_GUARDIAN_ACCOUNT_N_* env config in the backend.
-- Passwords are stored base64-encoded (shell-safe parity with the env file),
-- which is NOT an encryption boundary — table access is the security boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_guardian_accounts (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  secure BOOLEAN NOT NULL DEFAULT true,
  username TEXT NOT NULL,
  password_b64 TEXT NOT NULL,
  inbox TEXT NOT NULL DEFAULT 'INBOX',
  trash_mailbox TEXT,
  review_mailbox TEXT NOT NULL DEFAULT 'INBOX.Cortex Mail Guardian Review',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO migrations (name) VALUES ('011_mail_guardian') ON CONFLICT DO NOTHING;
