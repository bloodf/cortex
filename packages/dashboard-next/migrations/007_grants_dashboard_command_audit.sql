-- Migration 007: Grants for dashboard_command_audit.
--
-- Background (M0-A audit §15.5 follow-up):
--   The dashboard_command_audit table (created in 005) is NOT
--   append-only — it has a two-phase lifecycle:
--     1. INSERT row with status='created' before dispatching the
--        root-helper command (lib/db/dashboard-command-audit.ts:37-83).
--     2. UPDATE fills in completion fields after the root helper
--        returns (lib/db/dashboard-command-audit.ts:85-119).
--
--   For the lifecycle to work, the `dashboard` DB role needs both
--   INSERT and UPDATE on this table. The 001_schema.sql migration
--   revokes UPDATE/DELETE/TRUNCATE on `agent_gateway_audit` (the
--   truly append-only table) and grants INSERT/SELECT — that grant
--   pattern is preserved here for the `dashboard` role.
--
--   Contrast with `agent_gateway_audit`:
--     agent_gateway_audit:
--       REVOKE UPDATE, DELETE, TRUNCATE FROM dashboard
--       GRANT  INSERT, SELECT              TO   dashboard
--     dashboard_command_audit (this migration):
--       GRANT  INSERT, UPDATE, SELECT      TO   dashboard
--       (no REVOKE; the role gets the wider grant by design)
--
-- Why dashboard needs UPDATE but not DELETE/TRUNCATE:
--   UPDATE is required to fill in started_at, finished_at, exit_code,
--   status, error, etc. after the root helper returns. There is no
--   in-app path that should DELETE or TRUNCATE — if a row needs to
--   disappear it goes through the retention sweep, which runs as a
--   privileged role (not `dashboard`).
--
-- Idempotency: GRANT and REVOKE are idempotent at the Postgres level;
-- the entire block is wrapped in a DO ... END to stay silent when the
-- `dashboard` role has not yet been provisioned (fresh dev DB without
-- the role yet). This mirrors the pattern in 001_schema.sql:252-262.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard') THEN
    GRANT INSERT, UPDATE, SELECT ON dashboard_command_audit TO dashboard;
    -- Defensive: even though the role is not supposed to be able to
    -- mutate the table in destructive ways, ensure TRUNCATE and DELETE
    -- stay revoked in case a future migration broadens the grant.
    EXECUTE 'REVOKE DELETE, TRUNCATE ON dashboard_command_audit FROM dashboard';
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Non-fatal: same as 001:252-262. Fresh DBs without the `dashboard`
  -- role still apply the schema; the deploy step provisions the role
  -- and re-runs this migration.
  NULL;
END $$;
