-- Service dependency graph and lifecycle metadata.
-- Selected manifest catalog bootstrap supplies configured edges.
-- 1) service_dependencies table.
CREATE TABLE IF NOT EXISTS service_dependencies (
  id serial PRIMARY KEY,
  source_slug varchar(64) NOT NULL,          -- dependent (the consumer)
  target_slug varchar(64) NOT NULL,          -- dependency (the provider)
  kind varchar(16) NOT NULL DEFAULT 'configured'
    CHECK (kind IN ('configured', 'observed')),
  source varchar(16) NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed', 'detected', 'manual')),
  detail text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_slug, target_slug, kind)
);

-- 2) services columns for autostart control.
ALTER TABLE services ADD COLUMN IF NOT EXISTS autostart boolean NOT NULL DEFAULT true;
ALTER TABLE services ADD COLUMN IF NOT EXISTS unit_name varchar(128);
ALTER TABLE services ADD COLUMN IF NOT EXISTS container_names text;

