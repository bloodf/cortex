-- Migration 008: Create the dashboard_command_audit table.
--
-- Background (M0-A audit §15.5 + M1-WS6 data-schema gap):
--   The Drizzle schema in `packages/dashboard/src/lib/server/db/schema.ts:614-669`
--   declares a `dashboardCommandAudit` pgTable for the dashboard's privileged
--   command lifecycle (INSERT on dispatch → UPDATE on finish). The schema is
--   imported by every repo module under `db/repos/dashboard_command_audit.ts`,
--   the `/api/dashboard_command_audit` route, and the planned root-helper
--   executor (M3).
--
--   But no SQL migration in `migrations/` actually creates the table. The
--   runner just records the `migrations` row and continues; the Drizzle
--   `pgTable` is a TypeScript descriptor, not DDL. Against a fresh DB the
--   first INSERT/UPDATE blows up with `relation "dashboard_command_audit"
--   does not exist`, which is the root cause of the ~50 test failures
--   in `repos/__tests__/{alerts,audit,services,migrate}.test.ts` and
--   `__tests__/routes.test.ts`.
--
-- Filename choice:
--   Numbered `008` (after the existing `007_grants_dashboard_command_audit`)
--   so the file lands at the end of the lexical sort, but the table itself
--   has to exist BEFORE migration 007's GRANT runs. We rely on the fact
--   that the 007 grant block is wrapped in a `DO $$ ... IF EXISTS (role) ... END $$`
--   (see 007_grants_dashboard_command_audit.sql:37-51) — against PGlite and
--   any DB without the `dashboard` role provisioned yet, the GRANT is a
--   silent no-op. The order therefore does not matter at the SQL level;
--   ordering the file as 008 keeps the migration history monotonic for
--   humans reading the directory listing.
--
-- Shape:
--   Mirrors `dashboardCommandAudit` in `schema.ts` column-for-column,
--   using the Drizzle default `sql` expressions (defaultNow, jsonb defaults)
--   translated to their SQL equivalents. Indexes that are not already
--   provided by `006_indexes_for_rbac_audit.sql` (which adds only
--   `idx_dashboard_command_audit_session`) are created here.
--
-- Lifecycle (two-phase write, NOT append-only):
--   INSERT row with `status='created'` before dispatching the privileged
--   command (dashboard_command_audit.ts:37-83). After the helper returns,
--   UPDATE fills in `started_at`, `finished_at`, `stdout/stderr` sha256 +
--   byte counts, `exit_code`, `signal`, `status`, `error`, `journald_cursor`
--   (dashboard_command_audit.ts:85-119). The `agent_gateway_audit` table
--   is the true append-only audit log; this table is a two-phase lifecycle
--   record (THREAT_MODEL §6.1, SR-090).
--
-- Idempotency:
--   `CREATE TABLE IF NOT EXISTS` + `CREATE [UNIQUE] INDEX IF NOT EXISTS`.
--   The trigger is `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`
--   + `CREATE TRIGGER` (idempotent pattern from 005 in m0-a-cortexos-audit).
--   Safe to re-apply against an existing DB.
--
-- No self-record:
--   The migration runner records the filename itself. We do NOT add an
--   `INSERT INTO migrations (name) VALUES ('008_dashboard_command_audit')`
--   to avoid a UNIQUE collision with the runner's bookkeeping.

CREATE TABLE IF NOT EXISTS dashboard_command_audit (
  -- Surrogate primary key. request_id is the natural identifier, but a
  -- stable monotonic id is needed for admin pagination and the recent
  -- activity feed.
  id                       BIGSERIAL    PRIMARY KEY,

  -- Request identity
  request_id               TEXT         NOT NULL,
  requested_by             TEXT         NOT NULL DEFAULT 'trusted-dashboard',
  source_ip                INET         NULL,
  source_user_agent        TEXT         NULL,
  dashboard_session_id     TEXT         NULL,

  -- Command spec (what was requested)
  command                  TEXT         NOT NULL,
  argv                     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  cwd                      TEXT         NULL,
  env_allowlist            JSONB        NOT NULL DEFAULT '{"names": []}'::jsonb,
  stdin_sha256             TEXT         NULL,
  timeout_ms               INTEGER      NULL,
  approved_policy          TEXT         NOT NULL DEFAULT 'trusted-lan-tailnet',
  mutation_class           TEXT         NOT NULL DEFAULT 'unknown',
  target_scope             TEXT         NOT NULL DEFAULT 'host',
  dry_run                  BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Lifecycle (filled by finishDashboardCommandAudit)
  status                   TEXT         NOT NULL DEFAULT 'created',
  started_at               TIMESTAMPTZ  NULL,
  finished_at              TIMESTAMPTZ  NULL,
  stdout_sha256            TEXT         NULL,
  stderr_sha256            TEXT         NULL,
  stdout_bytes             INTEGER      NOT NULL DEFAULT 0,
  stderr_bytes             INTEGER      NOT NULL DEFAULT 0,
  exit_code                INTEGER      NULL,
  signal                   TEXT         NULL,
  error                    TEXT         NULL,
  journald_cursor          TEXT         NULL,

  -- Free-form bag (caller-defined; merged via `||` on UPDATE)
  metadata                 JSONB        NOT NULL DEFAULT '{}'::jsonb,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- request_id is the natural lookup key for the UPDATE ... WHERE request_id = $1
-- (dashboard_command_audit.ts:103) and the socket protocol's request_id echo.
-- The root-helper Unix-socket protocol guarantees a single attempt per
-- request_id per call, so UNIQUE is safe. The Drizzle schema declares the
-- same uniqueness twice (column-level `.unique()` + a uniqueIndex by name);
-- the explicit named index keeps the SQL filename aligned with the
-- `idx_dashboard_command_audit_request_id` references in the Drizzle
-- `indexes` block.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_command_audit_request_id
  ON dashboard_command_audit (request_id);

-- Recent activity feed (admin viewer pagination).
CREATE INDEX IF NOT EXISTS idx_dashboard_command_audit_created_at
  ON dashboard_command_audit (created_at DESC);

-- Per-operator queries (audit the actions of a specific dashboard user).
CREATE INDEX IF NOT EXISTS idx_dashboard_command_audit_requester_created
  ON dashboard_command_audit (requested_by, created_at DESC);

-- Status filter (e.g. "show me everything still in 'created' state",
-- or "all 'error' rows in the last 24h").
CREATE INDEX IF NOT EXISTS idx_dashboard_command_audit_status_created
  ON dashboard_command_audit (status, created_at DESC);

-- Command-name filter (e.g. "all docker invocations today").
CREATE INDEX IF NOT EXISTS idx_dashboard_command_audit_command_created
  ON dashboard_command_audit (command, created_at DESC);

-- Note: `idx_dashboard_command_audit_session` was moved from
-- 006_indexes_for_rbac_audit.sql in the M1.5 follow-up cleanup. It
-- belongs with the rest of this table's indexes because PostgreSQL
-- rejects CREATE INDEX on a non-existent relation; the table itself
-- only lands in this migration, so the index must come after.
CREATE INDEX IF NOT EXISTS idx_dashboard_command_audit_session
  ON dashboard_command_audit (dashboard_session_id, created_at DESC);

-- Auto-touch updated_at on UPDATE. Keeps the row honest without forcing
-- every caller to set it.
CREATE OR REPLACE FUNCTION dashboard_command_audit_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_command_audit_touch_updated_at
  ON dashboard_command_audit;

CREATE TRIGGER trg_dashboard_command_audit_touch_updated_at
  BEFORE UPDATE ON dashboard_command_audit
  FOR EACH ROW
  EXECUTE FUNCTION dashboard_command_audit_touch_updated_at();
