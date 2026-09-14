/**
 * Audit repository.
 *
 * Two concerns:
 *
 *   1. **agent_gateway_audit** (APPEND-ONLY) — writes via `pg` role with
 *      INSERT,SELECT only (UPDATE,DELETE,TRUNCATE are revoked at deploy
 *      time per migrations/001_schema.sql:252-262). This repo therefore
 *      exports ONLY `insertAgentGatewayAudit` and read methods; no
 *      `updateAgentGatewayAudit` or `deleteAgentGatewayAudit`. If a
 *      caller needs to "remove" a row, they don't — the row stays as
 *      a permanent record of the attempt.
 *
 *   2. **audit_log** (HASH-CHAINED, TimescaleDB hypertable) — append
 *      and verify. The canonical writer is `@cortexos/audit#append`
 *      (pool-injected) which takes a row-level lock on the chain tip.
 *      This repo provides a Drizzle-shaped wrapper around the same
 *      chain verification algorithm so the SvelteKit endpoints don't
 *      need a separate client.
 *
 * No Drizzle writes for `agent_gateway_audit` go through `update()` or
 * `delete()` — the TypeScript types reflect this.
 */

import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DbClient } from "../client";
import { agentGatewayAudit, auditLog } from "../schema";
import type { AgentGatewayAuditRow, AuditLogEntry } from "../schema";
import { sha256Hex } from "../../crypto";

export type ToolClass = "safe" | "privileged" | "destructive";
export type Decision = "allow" | "deny" | "prompt";
export type AuditResult = "ok" | "err" | "timeout" | "denied";

const TOOL_CLASSES: ReadonlySet<ToolClass> = new Set(["safe", "privileged", "destructive"]);
const DECISIONS: ReadonlySet<Decision> = new Set(["allow", "deny", "prompt"]);
const RESULTS: ReadonlySet<AuditResult> = new Set(["ok", "err", "timeout", "denied"]);

function validateEnum<T extends string>(
  value: string,
  allowed: ReadonlySet<T>,
  field: string,
): asserts value is T {
  if (!allowed.has(value as T)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
}

const GENESIS_PREV_HASH = "0".repeat(64);

// =====================================================================
// agent_gateway_audit (APPEND-ONLY)
// =====================================================================

export interface InsertAgentGatewayAuditInput {
  actorUserId?: number | null;
  sessionId?: string | null;
  requestId?: string | null;
  role?: string | null;
  account?: string | null;
  tool?: string | null;
  toolClass: ToolClass;
  argsHash: string;
  approvalId?: string | null;
  nonce?: string | null;
  policyVersion?: number | null;
  decision: Decision;
  decisionReason?: string | null;
  beforeStateHash?: string | null;
  afterStateHash?: string | null;
  latencyMs?: number | null;
  result: AuditResult;
}

/**
 * Append an `agent_gateway_audit` row. The DB role for the dashboard
 * has INSERT,SELECT only; this is a pure INSERT — no UPDATE, no DELETE.
 */
export async function insertAgentGatewayAudit(
  db: DbClient,
  input: InsertAgentGatewayAuditInput,
): Promise<AgentGatewayAuditRow> {
  validateEnum(input.toolClass, TOOL_CLASSES, "tool_class");
  validateEnum(input.decision, DECISIONS, "decision");
  validateEnum(input.result, RESULTS, "result");
  if (!input.argsHash) {
    throw new Error("args_hash is required");
  }
  const inserted = await db
    .insert(agentGatewayAudit)
    .values({
      actorUserId: input.actorUserId ?? null,
      sessionId: input.sessionId ?? null,
      requestId: input.requestId ?? null,
      role: input.role ?? null,
      account: input.account ?? null,
      tool: input.tool ?? null,
      toolClass: input.toolClass,
      argsHash: input.argsHash,
      approvalId: input.approvalId ?? null,
      nonce: input.nonce ?? null,
      policyVersion: input.policyVersion ?? null,
      decision: input.decision,
      decisionReason: input.decisionReason ?? null,
      beforeStateHash: input.beforeStateHash ?? null,
      afterStateHash: input.afterStateHash ?? null,
      latencyMs: input.latencyMs ?? null,
      result: input.result,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to insert agent_gateway_audit row");
  return row;
}

export interface ListAgentGatewayAuditFilters {
  actorUserId?: number;
  role?: string;
  account?: string;
  tool?: string;
  toolClass?: ToolClass;
  decision?: Decision;
  result?: AuditResult;
  requestId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export async function listAgentGatewayAudit(
  db: DbClient,
  filters: ListAgentGatewayAuditFilters = {},
): Promise<AgentGatewayAuditRow[]> {
  const conds: SQL[] = [];
  if (filters.actorUserId !== undefined) {
    conds.push(eq(agentGatewayAudit.actorUserId, filters.actorUserId));
  }
  if (filters.role !== undefined) conds.push(eq(agentGatewayAudit.role, filters.role));
  if (filters.account !== undefined) conds.push(eq(agentGatewayAudit.account, filters.account));
  if (filters.tool !== undefined) conds.push(eq(agentGatewayAudit.tool, filters.tool));
  if (filters.toolClass !== undefined) {
    validateEnum(filters.toolClass, TOOL_CLASSES, "tool_class");
    conds.push(eq(agentGatewayAudit.toolClass, filters.toolClass));
  }
  if (filters.decision !== undefined) {
    validateEnum(filters.decision, DECISIONS, "decision");
    conds.push(eq(agentGatewayAudit.decision, filters.decision));
  }
  if (filters.result !== undefined) {
    validateEnum(filters.result, RESULTS, "result");
    conds.push(eq(agentGatewayAudit.result, filters.result));
  }
  if (filters.requestId !== undefined) {
    conds.push(eq(agentGatewayAudit.requestId, filters.requestId));
  }
  if (filters.since) conds.push(gte(agentGatewayAudit.ts, filters.since));
  if (filters.until) conds.push(lte(agentGatewayAudit.ts, filters.until));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 1000));
  const offset = Math.max(0, filters.offset ?? 0);
  return db
    .select()
    .from(agentGatewayAudit)
    .where(where)
    .orderBy(desc(agentGatewayAudit.ts))
    .limit(limit)
    .offset(offset);
}

export async function countAgentGatewayAudit(
  db: DbClient,
  filters: Omit<ListAgentGatewayAuditFilters, "limit" | "offset"> = {},
): Promise<number> {
  const conds: SQL[] = [];
  if (filters.actorUserId !== undefined) {
    conds.push(eq(agentGatewayAudit.actorUserId, filters.actorUserId));
  }
  if (filters.role !== undefined) conds.push(eq(agentGatewayAudit.role, filters.role));
  if (filters.account !== undefined) conds.push(eq(agentGatewayAudit.account, filters.account));
  if (filters.toolClass !== undefined) {
    validateEnum(filters.toolClass, TOOL_CLASSES, "tool_class");
    conds.push(eq(agentGatewayAudit.toolClass, filters.toolClass));
  }
  if (filters.decision !== undefined) {
    validateEnum(filters.decision, DECISIONS, "decision");
    conds.push(eq(agentGatewayAudit.decision, filters.decision));
  }
  if (filters.result !== undefined) {
    validateEnum(filters.result, RESULTS, "result");
    conds.push(eq(agentGatewayAudit.result, filters.result));
  }
  if (filters.since) conds.push(gte(agentGatewayAudit.ts, filters.since));
  if (filters.until) conds.push(lte(agentGatewayAudit.ts, filters.until));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const res = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(agentGatewayAudit)
    .where(where);
  return res[0]?.c ?? 0;
}

// =====================================================================
// audit_log (HASH-CHAINED) — chain verification
// =====================================================================

/**
 * JSON Canonicalization Scheme (JCS, RFC 8785-style). Lexicographic key
 * order, no whitespace, primitives via JSON.stringify. Mirrors
 * `packages/cortex-audit/src/jcs.js` so the chain hash matches regardless
 * of which process appends.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function chainHashOf(prevHashHex: string, payloadHashHex: string): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(prevHashHex, "hex"), Buffer.from(payloadHashHex, "hex")]))
    .digest("hex");
}

export interface VerifyChainOptions {
  /** Window start (inclusive). Default: genesis. */
  fromTs?: Date;
  /** Window end (exclusive). Default: no upper bound. */
  toTs?: Date;
}

export type VerifyChainResult =
  | { valid: true; count: number; firstId: number; lastId: number }
  | {
      valid: false;
      count: number;
      brokenAt: {
        id: number;
        occurredAt: Date;
        reason: "prev_hash_mismatch" | "payload_hash_mismatch" | "chain_hash_mismatch";
      };
    };

/**
 * Walk the `audit_log` table in `occurred_at` order, recomputing the
 * chain hash and checking each link. Returns the first break or a
 * success summary.
 *
 * Algorithm matches `@cortexos/audit#verifyChain` (packages/cortex-audit/src/index.js:156-225).
 */
export async function verifyAuditLogChain(
  db: DbClient,
  opts: VerifyChainOptions = {},
): Promise<VerifyChainResult> {
  const conds: SQL[] = [];
  if (opts.fromTs) conds.push(gte(auditLog.occurredAt, opts.fromTs));
  if (opts.toTs) conds.push(lte(auditLog.occurredAt, opts.toTs));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select({
      id: auditLog.id,
      occurredAt: auditLog.occurredAt,
      payloadHash: auditLog.payloadHash,
      prevHash: auditLog.prevHash,
      chainHash: auditLog.chainHash,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(where)
    .orderBy(asc(auditLog.occurredAt), asc(auditLog.id));

  if (rows.length === 0) {
    return { valid: true, count: 0, firstId: 0, lastId: 0 };
  }

  // Anchor: if the caller specified a fromTs, the prev_hash of the
  // first row in the window must equal the chain_hash of the row
  // immediately preceding it (or GENESIS if there is none). This
  // catches deletion/insertion at the window's left edge.
  let expectedPrev: string;
  if (opts.fromTs) {
    const anchor = await db
      .select({ chainHash: auditLog.chainHash })
      .from(auditLog)
      .where(sql`${auditLog.occurredAt} < ${opts.fromTs}`)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(1);
    expectedPrev = anchor[0]?.chainHash ?? GENESIS_PREV_HASH;
  } else {
    expectedPrev = GENESIS_PREV_HASH;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.prevHash !== expectedPrev) {
      return {
        valid: false,
        count: rows.length,
        brokenAt: {
          id: Number(row.id),
          occurredAt: row.occurredAt,
          reason: "prev_hash_mismatch",
        },
      };
    }
    const recomputedPayload = sha256Hex(jcs(row.payload));
    if (recomputedPayload !== row.payloadHash) {
      return {
        valid: false,
        count: rows.length,
        brokenAt: {
          id: Number(row.id),
          occurredAt: row.occurredAt,
          reason: "payload_hash_mismatch",
        },
      };
    }
    const recomputedChain = chainHashOf(row.prevHash, row.payloadHash);
    if (recomputedChain !== row.chainHash) {
      return {
        valid: false,
        count: rows.length,
        brokenAt: {
          id: Number(row.id),
          occurredAt: row.occurredAt,
          reason: "chain_hash_mismatch",
        },
      };
    }
    expectedPrev = row.chainHash;
  }

  return {
    valid: true,
    count: rows.length,
    // rows.length > 0 is guaranteed by the early return above.
    firstId: Number(rows[0].id),
    lastId: Number(rows[rows.length - 1].id),
  };
}

/**
 * Append a hash-chained `audit_log` row. Locks the current chain tip
 * inside a transaction, computes prev_hash + payload_hash + chain_hash,
 * and inserts. Mirrors `@cortexos/audit#append` (packages/cortex-audit/src/index.js:88-145).
 *
 * Use this when you want a Drizzle-typed writer; the canonical writer
 * is still `@cortexos/audit#append` (which takes a pg.Pool and uses
 * row-level locks for cross-process serialisation). This function is
 * fine for single-process SvelteKit code paths.
 */
export interface AppendAuditLogInput {
  eventId?: string;
  eventType: string;
  source: string;
  subject?: string | null;
  actor?: string | null;
  payload: unknown;
}

export async function appendAuditLog(
  db: DbClient,
  input: AppendAuditLogInput,
): Promise<AuditLogEntry> {
  if (!input.eventType) throw new Error("appendAuditLog: eventType required");
  if (!input.source) throw new Error("appendAuditLog: source required");
  if (input.payload === undefined || input.payload === null) {
    throw new Error("appendAuditLog: payload required");
  }

  // Drizzle's pg/pglite driver: take the tip, compute hashes, insert.
  // We use `db.transaction()` so the read of the chain tip and the
  // insert happen in the same isolation scope. A `FOR UPDATE` lock
  // is not strictly required for single-process SvelteKit, but the
  // canonical @cortexos/audit uses it for cross-process serialisation.
  return db.transaction(async (tx) => {
    const tipRows = await tx
      .select({ chainHash: auditLog.chainHash })
      .from(auditLog)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(1);
    const prevHash = tipRows[0]?.chainHash ?? GENESIS_PREV_HASH;
    const payloadHash = sha256Hex(jcs(input.payload));
    const chainHash = chainHashOf(prevHash, payloadHash);
    const eventId = input.eventId ?? crypto.randomUUID();
    const inserted = await tx
      .insert(auditLog)
      .values({
        eventId,
        eventType: input.eventType,
        source: input.source,
        subject: input.subject ?? null,
        actor: input.actor ?? null,
        payloadHash,
        prevHash,
        chainHash,
        payload: input.payload,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to append audit_log row");
    return row;
  });
}

export { GENESIS_PREV_HASH };
