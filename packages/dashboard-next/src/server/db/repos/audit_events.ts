/**
 * Audit events repository.
 *
 * Reads from the `audit_log` hash-chained table and maps rows to the
 * `AuditEvent` entity shape used by the UI.
 */
import { and, desc, eq, gte, lte, like, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditLog } from "../schema";
import type { AuditLogEntry } from "../schema";
import type { AuditEvent } from "../../entities";
import { asAuditEventId } from "../../entities";

export interface ListAuditEventsOptions {
  actor?: string;
  surface?: string;
  action?: string;
  result?: "success" | "failure" | "denied" | "error";
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

const AUDIT_RESULTS = ["success", "failure", "denied", "error"] as const;

function toEntity(row: AuditLogEntry): AuditEvent {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  // The `audit_log` table has no dedicated result/errorCode columns; safeAudit
  // stores both inside the JSONB payload (server-fn-pipeline.persistDurableAudit:
  // payload.result ∈ success|failure|denied, payload.errorCode = err.kind). Recover
  // them here — hardcoding "success" made the Audit UI render every denied/failed
  // event as a green "allow", a security-monitoring blind spot.
  const rawResult = payload.result;
  const result: AuditEvent["result"] = AUDIT_RESULTS.includes(rawResult as AuditEvent["result"])
    ? (rawResult as AuditEvent["result"])
    : "success";
  const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : null;
  return {
    id: asAuditEventId(String(row.id)),
    actorUserId: row.actor ? (row.actor as AuditEvent["actorUserId"]) : null,
    actorSessionId: null,
    actorIp: null,
    actorUserAgent: null,
    surface: row.source,
    action: row.eventType,
    target: row.subject,
    result,
    errorCode,
    requestId: row.eventId,
    prevHash: row.prevHash,
    payloadHash: row.payloadHash,
    payload,
    createdAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
  };
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export async function listAuditEvents(
  db: DbClient,
  opts: ListAuditEventsOptions = {},
): Promise<{ rows: AuditEvent[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  const conds: SQL[] = [];
  if (opts.actor) conds.push(like(auditLog.actor, `%${opts.actor}%`));
  if (opts.surface) conds.push(eq(auditLog.source, opts.surface));
  if (opts.action) conds.push(eq(auditLog.eventType, opts.action));
  if (opts.since) conds.push(gte(auditLog.occurredAt, new Date(opts.since)));
  if (opts.until) conds.push(lte(auditLog.occurredAt, new Date(opts.until)));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(auditLog)
      .where(where),
  ]);

  return {
    rows: rows.map(toEntity),
    total: totalRow[0]?.count ?? 0,
  };
}

export async function getAuditEventById(db: DbClient, id: number): Promise<AuditEvent | null> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}
