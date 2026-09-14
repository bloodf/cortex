-- Migration 006: RBAC + audit indexes.
--
-- Background (M0-A audit §3.2, §3.5 + lib/db/ query patterns):
--   Several natural query patterns in the application code lack
--   supporting indexes. Without these, the dashboard's admin + audit
--   views will degrade to sequential scans as the data grows. This
--   migration is purely additive (CREATE INDEX IF NOT EXISTS).
--
-- Indexes added:
--
--   1. idx_admin_sessions_expires_at
--      On (admin_sessions.expires_at)
--      Supports:
--        - lib/db/admin.ts: listActiveSessions    (WHERE expires_at > NOW())
--        - lib/db/admin.ts: deleteExpiredSessions (WHERE expires_at <= NOW())
--        - lib/db/admin.ts: getSessionByToken     (token lookup; partially
--                                                 redundant with the existing
--                                                 token index)
--      Without this, both active-session listing and the 6 h retention
--      sweep become full table scans.
--
--   2. idx_action_log_user_created
--      On (action_log.user_id, created_at DESC)
--      Supports per-user action history (per-admin / per-operator
--      reporting). Currently absent; lib/db/action-log.ts:45 falls back
--      to a created_at scan.
--
--   3. idx_audit_log_actor
--      On (audit_log.actor, occurred_at DESC)
--      Supports per-actor history in the admin audit viewer.
--      lib/db/dashboard-audit.ts:139 filters by actor_user_id (a
--      different field) but the agent_gateway_audit indexes are
--      already there. This covers the hash-chained audit_log table
--      that audit.ts:186+ queries.
--
--   4. idx_audit_log_source
--      On (audit_log.source, occurred_at DESC)
--      Supports "show me everything from source=gateway" style
--      queries in the audit viewer.
--
-- Idempotency: every CREATE uses IF NOT EXISTS; safe to re-apply.
-- No self-record: the migration runner records the filename itself.
--
-- Note: `idx_dashboard_command_audit_session` was originally created here
-- in M0. The M1.5 follow-up moves the `dashboard_command_audit` table
-- itself into migration 008; the session index now lives in 008
-- alongside the rest of that table's indexes (the table has to exist
-- before any index on it can be created).

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_action_log_user_created
  ON action_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (actor, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_source
  ON audit_log (source, occurred_at DESC);
