#!/usr/bin/env node
/** Fresh Cortex database migrations. Run as the schema owner, not the dashboard role. */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

if (!process.env.DB_PASSWORD) throw new Error("DB_PASSWORD is required");
const client = new Client({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "cortex_dashboard",
  user: process.env.DB_USER || "cortex",
  password: process.env.DB_PASSWORD,
});
const directory = new URL("../migrations/", import.meta.url);
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(73921846)");
  await client.query(`CREATE TABLE IF NOT EXISTS dashboard_migrations (
    id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL,
    checksum CHAR(64) NOT NULL, applied_at TIMESTAMP DEFAULT NOW())`);
  const files = (await readdir(directory)).filter((name) => /^[a-zA-Z0-9_-]+\.sql$/.test(name)).sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
    const name = file.slice(0, -4);
    const { rows } = await client.query("SELECT checksum FROM dashboard_migrations WHERE name=$1", [name]);
    if (rows.length) {
      if (rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}; restore the original migration before proceeding`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO dashboard_migrations(name, checksum) VALUES ($1,$2)", [name, checksum]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    console.info(`Applied ${name}`);
  }
  console.info(`Schema ready: ${fileURLToPath(directory)}`);
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
