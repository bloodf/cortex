-- Migration 004: session GC index + pam_users username index.
--
-- A1 (persistent sessions, commit a22302c) made the DrizzleSessionStore
-- the default in production. The session store reads by `token` (already
-- indexed in 001) and the auth module now needs a periodic garbage
-- collection sweep that deletes rows where `expires_at < NOW()`.
--
-- Without an `expires_at` index, the GC query full-scans admin_sessions
-- which is fine while the table is small but degrades quickly under
-- load. Adding it now while the table is empty / small keeps the cost
-- zero.
--
-- The `pam_users.username` index is already implied by the UNIQUE
-- constraint (001), but adding it explicitly as `idx_pam_users_username`
-- makes the intent self-documenting for the auth store's upsert
-- path. PostgreSQL uses the unique constraint as an index, so this
-- is documentation-only — no extra index is created.

-- 1. expires_at index for the session GC sweep + `WHERE expires_at >
--    NOW()` in resolveByToken.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

-- 2. (user_id, expires_at) so the per-user "list active sessions"
--    query (in the audit page) doesn't need a sort step.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_expires
  ON admin_sessions (user_id, expires_at DESC);

-- 3. (last_role_check_at) so the SR-011/SR-012 re-validation
--    background task can find stale rows without scanning the table.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_role_check
  ON admin_sessions (last_role_check_at)
  WHERE last_role_check_at > 0;
