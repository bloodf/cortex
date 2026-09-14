/**
 * Pending approvals repository.
 *
 * Read-mostly surface; writes happen via approval actions. Supports
 * listing, filtering by status, and resolving.
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { pendingApprovals } from "../schema";
import type { PendingApproval, NewPendingApproval } from "../schema";

export interface ListPendingApprovalsOptions {
  /** Only unresolved (null resolvedAt). */
  openOnly?: boolean;
  /** Page (1-indexed). */
  page?: number;
  /** Page size. */
  pageSize?: number;
  /** Filter by runId (exact). */
  runId?: string;
  /** Filter by signalName (exact). */
  signalName?: string;
  /** Sort column. */
  sortBy?: "requestedAt" | "resolvedAt" | "id";
  /** Sort direction. */
  sortDir?: "asc" | "desc";
}

export interface PaginatedPendingApprovals {
  rows: PendingApproval[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export async function listPendingApprovals(
  db: DbClient,
  opts: ListPendingApprovalsOptions = {},
): Promise<PaginatedPendingApprovals> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  const conds: SQL[] = [];
  if (opts.openOnly) conds.push(isNull(pendingApprovals.resolvedAt));
  if (opts.runId) conds.push(eq(pendingApprovals.runId, opts.runId));
  if (opts.signalName) conds.push(eq(pendingApprovals.signalName, opts.signalName));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const sortBy = opts.sortBy ?? "requestedAt";
  const sortDir = opts.sortDir ?? "desc";
  let sortColumn;
  if (sortBy === "id") {
    sortColumn = pendingApprovals.id;
  } else if (sortBy === "resolvedAt") {
    sortColumn = pendingApprovals.resolvedAt;
  } else {
    sortColumn = pendingApprovals.requestedAt;
  }
  const order = sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(pendingApprovals)
      .where(where)
      .orderBy(order, asc(pendingApprovals.id))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(pendingApprovals)
      .where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export async function getPendingApprovalById(
  db: DbClient,
  id: number,
): Promise<PendingApproval | null> {
  const rows = await db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createPendingApproval(
  db: DbClient,
  input: NewPendingApproval,
): Promise<PendingApproval> {
  const inserted = await db.insert(pendingApprovals).values(input).returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create pending approval");
  return row;
}

export async function resolvePendingApproval(
  db: DbClient,
  id: number,
  decision: "approve" | "deny" | "timeout",
  approver: string,
  reason?: string | null,
): Promise<PendingApproval | null> {
  const res = await db
    .update(pendingApprovals)
    .set({
      decision,
      approver,
      resolvedAt: new Date(),
      ...(reason != null && reason !== "" ? { decisionReason: reason } : {}),
    })
    .where(eq(pendingApprovals.id, id))
    .returning();
  return res[0] ?? null;
}

export async function deletePendingApproval(db: DbClient, id: number): Promise<boolean> {
  const res = await db
    .delete(pendingApprovals)
    .where(eq(pendingApprovals.id, id))
    .returning({ id: pendingApprovals.id });
  return res.length > 0;
}
