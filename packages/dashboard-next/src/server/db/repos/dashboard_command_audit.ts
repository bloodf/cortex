/**
 * Dashboard command audit repository.
 *
 * Two-phase lifecycle (NOT append-only):
 *
 *   Phase 1 — `startDashboardCommand(input)`:
 *     INSERT a new row with `status='created'`, before dispatching the
 *     request to the execution pipeline.
 *     The row captures: who requested it, what command, with what args,
 *     what env-allowlist, what timeout, what policy + mutation_class.
 *
 *   Phase 2 — `finishDashboardCommand(requestId, completion)`:
 *     UPDATE the row by `request_id`, filling in started_at, finished_at,
 *     exit_code, signal, status ('ok' | 'error' | 'timeout' | ...),
 *     error, journald_cursor, and merging metadata. The unique index on
 *     `request_id` makes the UPDATE a single-row touch.
 *
 * The DB role (`dashboard`) needs INSERT,UPDATE,SELECT on this table.
 * migrations/007_grants_dashboard_command_audit.sql issues those grants
 * idempotently at deploy time.
 *
 * Why this is NOT the same as `agent_gateway_audit`:
 *   `agent_gateway_audit` is the **append-only** AI tool call trail —
 *   it never updates after the initial INSERT. `dashboard_command_audit`
 *   is a **two-phase execution log** — the row mutates as the command
 *   progresses through dispatch, exec, and completion.
 */

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { dashboardCommandAudit } from "../schema";
import type { DashboardCommandAudit, NewDashboardCommandAudit } from "../schema";

export interface StartCommandInput {
  requestId: string;
  requestedBy?: string;
  sourceIp?: string | null;
  sourceUserAgent?: string | null;
  dashboardSessionId?: string | null;
  command: string;
  argv: string[];
  cwd?: string | null;
  envAllowlist?: string[];
  stdinSha256?: string | null;
  timeoutMs?: number;
  approvedPolicy?: string;
  mutationClass?: string;
  targetScope?: string;
  dryRun?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FinishCommandInput {
  startedAt?: Date | null;
  finishedAt?: Date | null;
  stdoutSha256?: string | null;
  stderrSha256?: string | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  exitCode?: number | null;
  signal?: string | null;
  status: string;
  error?: string | null;
  journaldCursor?: string | null;
  metadata?: Record<string, unknown>;
}

const ALLOWED_FINISH_KEYS = new Set([
  "startedAt",
  "finishedAt",
  "stdoutSha256",
  "stderrSha256",
  "stdoutBytes",
  "stderrBytes",
  "exitCode",
  "signal",
  "status",
  "error",
  "journaldCursor",
  "metadata",
]);

/**
 * Phase 1: INSERT a new dashboard_command_audit row.
 */
export async function startDashboardCommand(
  db: DbClient,
  input: StartCommandInput,
): Promise<DashboardCommandAudit> {
  if (!input.requestId) {
    throw new Error("startDashboardCommand: requestId is required");
  }
  if (!input.command) {
    throw new Error("startDashboardCommand: command is required");
  }
  if (!Array.isArray(input.argv)) {
    throw new Error("startDashboardCommand: argv must be an array");
  }

  const values: NewDashboardCommandAudit = {
    requestId: input.requestId,
    requestedBy: input.requestedBy ?? "trusted-dashboard",
    sourceIp: input.sourceIp ?? null,
    sourceUserAgent: input.sourceUserAgent ?? null,
    dashboardSessionId: input.dashboardSessionId ?? null,
    command: input.command,
    argv: input.argv,
    cwd: input.cwd ?? null,
    envAllowlist: { names: input.envAllowlist ?? [] },
    stdinSha256: input.stdinSha256 ?? null,
    timeoutMs: input.timeoutMs ?? null,
    approvedPolicy: input.approvedPolicy ?? "trusted-lan-tailnet",
    mutationClass: input.mutationClass ?? "unknown",
    targetScope: input.targetScope ?? "host",
    dryRun: input.dryRun ?? false,
    status: "created",
    metadata: input.metadata ?? {},
  };

  const inserted = await db.insert(dashboardCommandAudit).values(values).returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create dashboard_command_audit row");
  return row;
}

/**
 * Phase 2: UPDATE the row by `request_id`, filling in completion fields.
 *
 * Allowed keys are whitelisted (unknown keys throw). All typed scalar
 * fields are set via Drizzle's typed `.set()` so the values are
 * parameterised at the SQL level. The metadata merge is done in a
 * second raw-SQL UPDATE (jsonb `||`) also parameterised. This gives
 * us both type safety and SQL-injection safety.
 */
export async function finishDashboardCommand(
  db: DbClient,
  requestId: string,
  completion: FinishCommandInput,
): Promise<DashboardCommandAudit | null> {
  if (!requestId) {
    throw new Error("finishDashboardCommand: requestId is required");
  }
  if (!completion.status) {
    throw new Error("finishDashboardCommand: status is required");
  }
  Object.keys(completion).forEach((k) => {
    if (!ALLOWED_FINISH_KEYS.has(k)) {
      throw new Error(`finishDashboardCommand: unexpected key ${k}`);
    }
  });

  // Step 1: typed UPDATE for the scalar fields. Drizzle parameterises
  // every value; the requestId is bound via `eq()`.
  const setFields: Partial<typeof dashboardCommandAudit.$inferInsert> = {
    status: completion.status,
  };
  if (completion.startedAt !== undefined) setFields.startedAt = completion.startedAt;
  if (completion.finishedAt !== undefined) setFields.finishedAt = completion.finishedAt;
  if (completion.stdoutSha256 !== undefined) setFields.stdoutSha256 = completion.stdoutSha256;
  if (completion.stderrSha256 !== undefined) setFields.stderrSha256 = completion.stderrSha256;
  if (completion.stdoutBytes !== undefined) setFields.stdoutBytes = completion.stdoutBytes;
  if (completion.stderrBytes !== undefined) setFields.stderrBytes = completion.stderrBytes;
  if (completion.exitCode !== undefined) setFields.exitCode = completion.exitCode;
  if (completion.signal !== undefined) setFields.signal = completion.signal;
  if (completion.error !== undefined) setFields.error = completion.error;
  if (completion.journaldCursor !== undefined) setFields.journaldCursor = completion.journaldCursor;

  // updated_at is auto-touched by the trigger (005_dashboard_command_audit.sql:114-127),
  // but we also set it explicitly to be safe under pglite (which may
  // not run triggers during a transaction until commit).
  setFields.updatedAt = new Date();

  const updated = await db
    .update(dashboardCommandAudit)
    .set(setFields)
    .where(eq(dashboardCommandAudit.requestId, requestId))
    .returning();
  if (updated.length === 0) {
    return null;
  }

  // Step 2: if metadata was provided, merge it (jsonb `||`).
  // Done in a parameterised raw SQL UPDATE so the JSON value is bound
  // as a $1 parameter and never interpolated into the SQL string.
  if (completion.metadata !== undefined) {
    await db.execute(
      sql`UPDATE dashboard_command_audit
			    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(completion.metadata)}::jsonb
			    WHERE request_id = ${requestId}`,
    );
  }

  const final = await db
    .select()
    .from(dashboardCommandAudit)
    .where(eq(dashboardCommandAudit.requestId, requestId))
    .limit(1);
  return final[0] ?? null;
}

// =====================================================================
// Read paths
// =====================================================================

export interface ListDashboardCommandsOptions {
  status?: string;
  command?: string;
  requestedBy?: string;
  dashboardSessionId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export async function listDashboardCommands(
  db: DbClient,
  opts: ListDashboardCommandsOptions = {},
): Promise<DashboardCommandAudit[]> {
  const conds: SQL[] = [];
  if (opts.status) conds.push(eq(dashboardCommandAudit.status, opts.status));
  if (opts.command) conds.push(eq(dashboardCommandAudit.command, opts.command));
  if (opts.requestedBy) {
    conds.push(eq(dashboardCommandAudit.requestedBy, opts.requestedBy));
  }
  if (opts.dashboardSessionId) {
    conds.push(eq(dashboardCommandAudit.dashboardSessionId, opts.dashboardSessionId));
  }
  if (opts.since) conds.push(sql`${dashboardCommandAudit.createdAt} >= ${opts.since}`);
  if (opts.until) conds.push(sql`${dashboardCommandAudit.createdAt} <= ${opts.until}`);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const offset = Math.max(0, opts.offset ?? 0);
  return db
    .select()
    .from(dashboardCommandAudit)
    .where(where)
    .orderBy(desc(dashboardCommandAudit.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getDashboardCommandByRequestId(
  db: DbClient,
  requestId: string,
): Promise<DashboardCommandAudit | null> {
  const rows = await db
    .select()
    .from(dashboardCommandAudit)
    .where(eq(dashboardCommandAudit.requestId, requestId))
    .limit(1);
  return rows[0] ?? null;
}

export async function countDashboardCommands(
  db: DbClient,
  opts: Omit<ListDashboardCommandsOptions, "limit" | "offset"> = {},
): Promise<number> {
  const conds: SQL[] = [];
  if (opts.status) conds.push(eq(dashboardCommandAudit.status, opts.status));
  if (opts.command) conds.push(eq(dashboardCommandAudit.command, opts.command));
  if (opts.requestedBy) {
    conds.push(eq(dashboardCommandAudit.requestedBy, opts.requestedBy));
  }
  if (opts.dashboardSessionId) {
    conds.push(eq(dashboardCommandAudit.dashboardSessionId, opts.dashboardSessionId));
  }
  if (opts.since) conds.push(sql`${dashboardCommandAudit.createdAt} >= ${opts.since}`);
  if (opts.until) conds.push(sql`${dashboardCommandAudit.createdAt} <= ${opts.until}`);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const res = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(dashboardCommandAudit)
    .where(where);
  return res[0]?.c ?? 0;
}
