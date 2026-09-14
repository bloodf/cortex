-- Migration 002: extend admin_sessions for real auth (PAM + cookies + CSRF)
--
-- M2-WS3 (Kleppmann) replaces the M1-WS4 fake auth stub with a real
-- PAM-backed session. The new auth layer stores per-session metadata
-- in `admin_sessions` so that:
--   - the CSRF token can be rotated and verified per request
--   - the role (is_admin) is re-validated on a TTL (THREAT_MODEL SR-011/012)
--   - the user-agent and source IP are bound to the session for
--     defence-in-depth and forensic reconstruction
--
-- All new columns are nullable / have defaults so that the migration
-- is safe to apply against an existing DB with admin_sessions rows
-- from the M1 stub (the cookie-token type is widened to TEXT — the
-- 255-char column was sized for a 32-byte hex token; the real session
-- uses 32 random bytes base64url-encoded which still fits, but TEXT
-- is safer for the future).

-- 1. Widen the token column. The dashboard session token is the
--    raw 32-byte CSPRNG output, base64url-encoded (~43 chars). The
--    previous VARCHAR(255) was sized for a 32-byte HEX string (64
--    chars). TEXT removes the artificial limit.
ALTER TABLE admin_sessions
  ALTER COLUMN token TYPE TEXT;

-- 2. Per-session CSRF token (THREAT_MODEL SR-004).
--    Server-side; the cookie carries a copy for the double-submit
--    check. Length 64 covers a 32-byte CSPRNG base64url (43 chars)
--    with headroom; the column is TEXT for safety.
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS csrf_token TEXT;

-- 3. Source IP (best-effort, set on every createSession; nullable
--    so legacy rows / future privacy modes are supported).
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS ip TEXT;

-- 4. User-Agent header snapshot.
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- 5. Role re-validation timestamp (ms epoch as BIGINT, per SR-011).
--    The SvelteKit hook re-checks is_admin when this is older than
--    ROLE_CHECK_TTL_MS (default 60s) and updates both is_admin and
--    this column atomically.
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS last_role_check_at BIGINT NOT NULL DEFAULT 0;

-- 6. Touched-at timestamp (for rolling 30-day expiry per task spec).
--    On every authenticated request the server extends expires_at to
--    now + 30d, capped at created_at + 30d so an idle session cannot
--    extend indefinitely.
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS touched_at TIMESTAMP;

-- 7. Backfill touched_at for existing rows so the new rolling-expiry
--    logic has a defined value (NULL would be treated as 0 by the
--    timestamp comparison).
UPDATE admin_sessions
   SET touched_at = created_at
 WHERE touched_at IS NULL;

-- 8. Index supporting the /api/auth/login "is there already a session
--    for this user+ip" check, and the periodic expired sweep.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_touched_at
  ON admin_sessions (touched_at);

-- 9. Index supporting per-user session listing in the (future)
--    "active sessions" view.
--    Note: idx_admin_sessions_user (on user_id) already exists in 001.
--    Adding (user_id, touched_at) so the typical "my active sessions"
--    query is index-only.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_touched
  ON admin_sessions (user_id, touched_at DESC);
