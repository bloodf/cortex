#!/usr/bin/env node
/** Reconcile only installer-managed catalog entries; never copy an existing host inventory. */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { Client } from "pg";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--manifest") throw new Error("Usage: bootstrap-catalog.mjs --manifest /etc/cortex/install.json");
const manifestPath = resolve(args[1]);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
// The same canonical validator used by plan/apply must approve this file before DB mutation.
execFileSync("python3", [join(repository, "installer/main.py"), "validate", "--manifest", manifestPath], { stdio: "pipe" });
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const catalog = JSON.parse(await readFile(join(repository, "catalog/services.json"), "utf8"));
const selected = new Set(manifest.services);
const definitions = new Map(catalog.services.map((service) => [service.id, service]));
for (const id of selected) if (!definitions.has(id)) throw new Error(`Unknown selected service: ${id}`);
const appRole = process.env.CORTEX_DB_APP_ROLE || "dashboard";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) throw new Error("Invalid CORTEX_DB_APP_ROLE");
if (!process.env.DB_PASSWORD) throw new Error("DB_PASSWORD is required");
const client = new Client({ host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || "cortex_dashboard", user: process.env.DB_USER || "cortex", password: process.env.DB_PASSWORD });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(73921846)");
  const { rows: roles } = await client.query("SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolname = current_user AS owns_connection FROM pg_roles WHERE rolname=$1", [appRole]);
  if (!roles.length || roles[0].rolsuper || roles[0].rolcreaterole || roles[0].rolcreatedb || roles[0].rolbypassrls || roles[0].owns_connection) throw new Error("Dashboard application role must exist and be separate from the privileged schema owner");
  const { rows: ownership } = await client.query("SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND r.rolname=$1 LIMIT 1", [appRole]);
  if (ownership.length) throw new Error("Dashboard role must not own schema objects");
  const { rows: previous } = await client.query("SELECT value FROM config WHERE key='installer.managed_services' FOR UPDATE");
  const oldIds = previous.length ? JSON.parse(previous[0].value) : [];
  const removed = oldIds.filter((id) => !selected.has(id));
  if (removed.length) {
    await client.query("DELETE FROM service_dependencies WHERE source_slug=ANY($1::text[]) OR target_slug=ANY($1::text[])", [removed]);
    await client.query("DELETE FROM services WHERE slug=ANY($1::text[])", [removed]);
  }
  for (const id of selected) {
    const service = definitions.get(id);
    const view = service.dashboard || {};
    const healthType = view.health_type || (service.kind === "compose" ? "docker" : "systemd");
    const containers = view.container_names || (service.kind === "compose" ? [`cortex-${id}`] : []);
    const unit = view.unit_name || (id === "dashboard" ? "cortex-dashboard.service" : null);
    const health = view.health_url || (healthType === "docker" ? containers[0] : unit || service.endpoint || "#");
    const open = id === "dashboard" ? manifest.network.public_url : view.open_url || "#";
    const envFile = view.env_file ? join(process.env.CORTEX_SECRETS_DIR || "/etc/cortex/secrets", view.env_file) : null;
    await client.query(`INSERT INTO services (slug,name,kind,category,description,health_url,health_type,open_url,env_source,is_active,has_webui,show_in_webui,show_in_healthcheck,unit_name,container_names)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$10,$11,$12,$13)
      ON CONFLICT(slug) DO UPDATE SET name=excluded.name,kind=excluded.kind,category=excluded.category,description=excluded.description,health_url=excluded.health_url,health_type=excluded.health_type,open_url=excluded.open_url,env_source=excluded.env_source,is_active=true,has_webui=excluded.has_webui,show_in_webui=excluded.show_in_webui,show_in_healthcheck=excluded.show_in_healthcheck,unit_name=excluded.unit_name,container_names=excluded.container_names,updated_at=now()`,
      [id,service.title,service.kind === "compose" ? "docker" : "service",view.category || "platform",service.description,health,healthType,open,envFile,open !== "#",health !== "#",unit,JSON.stringify(containers)]);
    await client.query("DELETE FROM service_dependencies WHERE source_slug=$1 AND source='seed'", [id]);
    for (const dependency of service.depends_on) {
      if (!selected.has(dependency)) throw new Error(`Missing selected dependency ${id} -> ${dependency}`);
      await client.query("INSERT INTO service_dependencies(source_slug,target_slug,kind,source,detail) VALUES($1,$2,'configured','seed',$3) ON CONFLICT(source_slug,target_slug,kind) DO NOTHING", [id, dependency, "Selected installation dependency"]);
    }
  }
  await client.query("INSERT INTO config(key,value) VALUES('installer.managed_services',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [JSON.stringify([...selected])]);
  // Apply privileges after every migration. Future tables start inaccessible until this bootstrap runs.
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO "${appRole}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${appRole}";
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRole}";
    REVOKE ALL ON dashboard_migrations,migrations FROM "${appRole}";
    REVOKE UPDATE,DELETE,TRUNCATE ON agent_gateway_audit,audit_log,action_log FROM "${appRole}";
    GRANT UPDATE(rekor_log_index) ON audit_log TO "${appRole}";
    REVOKE DELETE,TRUNCATE ON dashboard_command_audit FROM "${appRole}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${appRole}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "${appRole}";`);
  await client.query("COMMIT");
  console.info(`Catalog ready: ${selected.size} selected services; application grants applied`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Catalog bootstrap failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
