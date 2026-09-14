-- Migration 003: Create the incus_instances table.
--
-- Background:
--   The Drizzle schema in `packages/dashboard/src/lib/server/db/schema.ts:530-552`
--   declares an `incusInstances` pgTable for the Incus provisioning wizard
--   (per-instance saved config + lifecycle status). M1-WS6 (data schema) and
--   M2-WS1 (Services feature) both reference the table; the route module
--   `src/routes/api/incus/**/+server.ts` reads/writes it.
--
--   But no migration in `001_schema.sql` creates the table. The runner
--   records the migration row, the Drizzle `pgTable` is purely a TypeScript
--   descriptor, and the first Incus query blows up with
--   `relation "incus_instances" does not exist`.
--
-- Filename choice:
--   `003` is the next free slot between 002_session_columns_for_auth.sql
--   (M2-WS3) and 006_indexes_for_rbac_audit.sql (M1-WS6). The earlier
--   `002_seed.sql` mentioned in the legacy `migrate.test.ts` is gone (the
--   002 in this branch is the auth-columns migration from M2-WS3); the test
--   is updated to match.
--
-- Shape:
--   Mirrors `incusInstances` in `schema.ts` column-for-column. Includes the
--   status CHECK constraint (`draft|validated|provisioning|active|failed`)
--   which is declared on the Drizzle side as a `check('incus_instances_status_check', ...)`.
--   The two named indexes (`idx_incus_instances_status`, `idx_incus_instances_slug`)
--   are also created here; the schema uses `on(t.status)` and `on(t.slug)`
--   which both translate to plain non-unique btree indexes.
--
-- Idempotency:
--   `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`. Safe to
--   re-apply against an existing DB.
--
-- No self-record:
--   The migration runner records the filename itself. We do NOT add an
--   `INSERT INTO migrations (name) VALUES ('003_incus_instances')` to
--   avoid a UNIQUE collision with the runner's bookkeeping.

CREATE TABLE IF NOT EXISTS incus_instances (
  id                BIGSERIAL    PRIMARY KEY,
  name              TEXT         NOT NULL UNIQUE,
  slug              TEXT         NULL,
  status            TEXT         NOT NULL DEFAULT 'draft',
  config            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  last_validation   JSONB        NULL,
  last_request_id   UUID         NULL,
  created_by        TEXT         NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT incus_instances_status_check
    CHECK (status IN ('draft', 'validated', 'provisioning', 'active', 'failed'))
);

-- Status filter (most common wizard query: "show me all active / failed
-- instances"). The Drizzle side declares this as `index("idx_incus_instances_status").on(t.status)`.
CREATE INDEX IF NOT EXISTS idx_incus_instances_status
  ON incus_instances (status);

-- Slug lookup (URL-friendly identifier for the Incus detail page).
-- Drizzle: `index("idx_incus_instances_slug").on(t.slug)`.
CREATE INDEX IF NOT EXISTS idx_incus_instances_slug
  ON incus_instances (slug);
