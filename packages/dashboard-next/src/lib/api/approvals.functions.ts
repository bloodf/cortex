/**
 * Approvals + Audit + Command-audit — server functions (WP-16). SECURITY-SENSITIVE.
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/audit + the business handler. All server-only logic (the approval
 * crypto, the audit chain verifier, the DB repos) is imported DYNAMICALLY inside
 * each handler so import-protection never sees `@/server/**` in the client bundle.
 *
 * The approval HMAC crypto (mint/verify/consume) is WP-03's `src/server/approval`
 * and the audit chain-verify is WP-02's `src/server/db/repos/audit`. This WP only
 * CALLS them — it never reimplements the crypto or the chain walk.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/approvals/+server.ts                 (list/mint/revoke)
 *   packages/dashboard/src/routes/api/approvals/[id]/grant/+server.ts      (grant)
 *   packages/dashboard/src/routes/api/approvals/[id]/revoke/+server.ts     (revoke)
 *   packages/dashboard/src/routes/api/audit/+server.ts                     (list)
 *   packages/dashboard/src/routes/api/audit/verify/+server.ts             (chain verify)
 *   packages/dashboard/src/routes/api/dashboard_command_audit/+server.ts  (two-phase)
 *
 * Frontend (Wave 2) calls these typed:
 *   await listApprovals({ data: { status: 'open' } })
 *   await mintApproval({ data: { action: 'docker.stop', payload: { container } } })
 *   await verifyAudit({ data: {} })
 */

import { createServerFn } from "@tanstack/react-start";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas (mirror the legacy zod validation exactly)
// ---------------------------------------------------------------------------

const ApprovalListInput = z
  .object({
    status: z.enum(["open", "all"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const ApprovalIdInput = z.object({ id: z.coerce.number().int().positive() }).strict();
const RevokeInput = z
  .object({
    id: z.coerce.number().int().positive(),
    reason: z.string().max(1000).optional(),
  })
  .strict();

const MintInput = z
  .object({
    action: z.string().min(1).max(256),
    payload: z.record(z.string(), z.unknown()).default({}),
    ttlSec: z.number().int().min(1).max(3600).optional(),
  })
  .strict();

const GrantInput = z
  .object({
    id: z.coerce.number().int().positive(),
    /** Optional TTL override for the minted grant token. */
    ttlSec: z.number().int().min(1).max(3600).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// listApprovals — GET, auth: any → { pending: PendingApproval[], total, page, pageSize }
// ---------------------------------------------------------------------------

const listApprovalsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ApprovalListInput,
  surface: "approvals",
  action: "approvals.list",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { listPendingApprovals } = await import("@/server/db/repos/pending_approvals");
    const { rows, total, page, pageSize } = await listPendingApprovals(getDb(), {
      openOnly: input.status !== "all",
      page: input.page,
      pageSize: input.pageSize,
    });
    return { pending: rows, total, page, pageSize };
  },
});
export const listApprovals = createServerFn({ method: "GET" })
  .middleware([listApprovalsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// mintApproval — POST, auth: admin → { token, expiresAt, issuedAt, actionHash, ttlSec }
// Reuses WP-03's HMAC mint (src/server/approval). The token is bound to the
// consuming session (PB-1 / SR-020): only the same session may consume it.
// ---------------------------------------------------------------------------

const mintApprovalGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: MintInput,
  // SR-200: stricter limit for the token-mint endpoint.
  rateLimit: { limit: 30, windowSec: 60, bucket: "ip" },
  surface: "approvals",
  action: "approvals.mint",
  target: (input) => input.action,
  handler: async ({ user, input, ctx }) => {
    const { mintApproval: mint } = await import("@/server/approval");
    const { systemError } = await import("@/server/errors/types");

    const sessionId = ctx.session?.id ?? null;
    if (!sessionId || !user) {
      // requireAdmin already ensured a session; guard defensively.
      throw systemError("Session required for approval minting");
    }
    const ttl = input.ttlSec ?? (input.action.startsWith("reveal.") ? 300 : 60);
    const token = mint({
      action: input.action,
      payload: input.payload,
      sessionId,
      userId: user.id,
      ttlSec: ttl,
    });
    return {
      token: token.token,
      expiresAt: token.expiresAt,
      issuedAt: token.issuedAt,
      actionHash: token.actionHash,
      ttlSec: token.ttlSec,
    };
  },
});
export const mintApproval = createServerFn({ method: "POST" })
  .middleware([mintApprovalGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// grantApproval — POST, auth: admin → { ok: true, token, expiresAt, actionHash }
// Resolves the pending_approvals row (decision='approve') AND mints a fresh
// short-lived HMAC token the requesting process can present as
// `x-cortex-approval-token`. The token is bound to the granting admin's session.
// ---------------------------------------------------------------------------

const grantApprovalGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: GrantInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "approvals",
  action: "approvals.grant",
  target: (input) => String(input.id),
  handler: async ({ user, input, ctx }) => {
    const { getDb } = await import("@/server/db/client");
    const { getPendingApprovalById, resolvePendingApproval } =
      await import("@/server/db/repos/pending_approvals");
    const { mintApproval: mint } = await import("@/server/approval");
    const { notFoundError, validationError, systemError } = await import("@/server/errors/types");

    const sessionId = ctx.session?.id ?? null;
    if (!sessionId || !user) {
      throw systemError("Session required for approval granting");
    }

    const db = getDb();
    const row = await getPendingApprovalById(db, input.id);
    if (!row) throw notFoundError(`Approval ${input.id} not found`, "approval");
    // Idempotency: a second grant on an already-resolved row is a 400.
    if (row.decision !== null) {
      throw validationError(
        row.decision === "approve" ? "Approval already granted" : "Approval already resolved",
      );
    }

    const updated = await resolvePendingApproval(db, input.id, "approve", user.username);
    if (!updated) throw notFoundError(`Approval ${input.id} not found`, "approval");

    // Mint a fresh token bound to the granting admin's session + the row's
    // signal/run so the requesting process can consume it (single-use).
    const ttl = input.ttlSec ?? 60;
    const token = mint({
      action: updated.signalName,
      payload: { runId: updated.runId, role: updated.role ?? "", approver: user.username },
      sessionId,
      userId: user.id,
      ttlSec: ttl,
    });

    return {
      ok: true as const,
      token: token.token,
      expiresAt: token.expiresAt,
      actionHash: token.actionHash,
      ttlSec: token.ttlSec,
    };
  },
});
export const grantApproval = createServerFn({ method: "POST" })
  .middleware([grantApprovalGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// revokeApproval — POST, auth: admin → { ok: true }
// Resolves the row with decision='deny'.
// ---------------------------------------------------------------------------

const revokeApprovalGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: RevokeInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "approvals",
  action: "approvals.revoke",
  target: (input) => String(input.id),
  handler: async ({ user, input }) => {
    const { getDb } = await import("@/server/db/client");
    const { resolvePendingApproval } = await import("@/server/db/repos/pending_approvals");
    const { notFoundError, systemError } = await import("@/server/errors/types");
    if (!user) throw systemError("Session required for approval revocation");
    const updated = await resolvePendingApproval(
      getDb(),
      input.id,
      "deny",
      user.username,
      input.reason,
    );
    if (!updated) throw notFoundError(`Approval ${input.id} not found`, "approval");
    return { ok: true as const };
  },
});
export const revokeApproval = createServerFn({ method: "POST" })
  .middleware([revokeApprovalGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// deleteApproval — POST, auth: admin → { ok: true } | 404
// ---------------------------------------------------------------------------

const deleteApprovalGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ApprovalIdInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "approvals",
  action: "approvals.delete",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { deletePendingApproval } = await import("@/server/db/repos/pending_approvals");
    const { notFoundError } = await import("@/server/errors/types");
    const ok = await deletePendingApproval(getDb(), input.id);
    if (!ok) throw notFoundError(`Approval ${input.id} not found`, "approval");
    return { ok: true as const };
  },
});
export const deleteApproval = createServerFn({ method: "POST" })
  .middleware([deleteApprovalGate])
  .handler(serverFnNoop);

// ===========================================================================
// Audit
// ===========================================================================

const AuditListInput = z
  .object({
    actor: z.string().min(1).max(256).optional(),
    surface: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(128).optional(),
    result: z.string().min(1).max(32).optional(),
    since: z.string().min(1).max(64).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const AuditVerifyInput = z
  .object({
    from: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Map an `audit_log` row to a flat `AuditEvent`-shaped record. The hash-chained
 * `audit_log` table stores the event detail in `payload` (JSONB); `source` is
 * the surface and `event_type` is the action. We surface the columns the UI
 * consumes and fold the redacted payload through verbatim.
 */
// (mapping inlined in the handler so it stays server-only)

// ---------------------------------------------------------------------------
// listAudit — GET, auth: any → { events, surfaces, actions, total, page, pageSize }
// ---------------------------------------------------------------------------

const listAuditGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: AuditListInput,
  surface: "audit",
  action: "audit.list",
  handler: async ({ input }) => {
    const { and, asc, desc, eq, gte, sql } = await import("drizzle-orm");
    const { getDb } = await import("@/server/db/client");
    const { auditLog } = await import("@/server/db/schema");
    const { validationError } = await import("@/server/errors/types");

    const db = getDb();
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, input.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    const conds: SQL[] = [];
    if (input.actor) conds.push(eq(auditLog.actor, input.actor));
    // `source` is the surface column; `event_type` is the action.
    if (input.surface) conds.push(eq(auditLog.source, input.surface));
    if (input.action) conds.push(eq(auditLog.eventType, input.action));
    if (input.since) {
      const since = new Date(input.since);
      if (Number.isNaN(since.getTime())) {
        throw validationError("Invalid `since` date", [
          { field: "since", message: "must be an ISO 8601 date string" },
        ]);
      }
      conds.push(gte(auditLog.occurredAt, since));
    }
    // `result` lives in the JSONB payload; filter on it when present.
    if (input.result) {
      conds.push(sql`${auditLog.payload} ->> 'result' = ${input.result}`);
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    const [rows, totalRow, surfaceRows, actionRows] = await Promise.all([
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
      db.selectDistinct({ surface: auditLog.source }).from(auditLog).orderBy(asc(auditLog.source)),
      db
        .selectDistinct({ action: auditLog.eventType })
        .from(auditLog)
        .orderBy(asc(auditLog.eventType)),
    ]);

    const events = rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        id: String(row.id),
        eventId: row.eventId,
        occurredAt:
          row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
        surface: row.source,
        action: row.eventType,
        actor: row.actor,
        subject: row.subject,
        result: typeof payload.result === "string" ? payload.result : null,
        payloadHash: row.payloadHash,
        payload,
      };
    });

    return {
      events,
      surfaces: surfaceRows.map((r) => r.surface),
      actions: actionRows.map((r) => r.action),
      total: totalRow[0]?.count ?? 0,
      page,
      pageSize,
    };
  },
});
export const listAudit = createServerFn({ method: "GET" })
  .middleware([listAuditGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// verifyAudit — GET, auth: admin → { ok, count, brokenAt? }
// Calls WP-02's `verifyAuditLogChain` (the HMAC chain walk) directly.
// ---------------------------------------------------------------------------

const verifyAuditGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: AuditVerifyInput,
  rateLimit: { limit: 5, windowSec: 60, bucket: "user" },
  surface: "audit",
  action: "audit.verify",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { verifyAuditLogChain } = await import("@/server/db/repos/audit");
    const { validationError } = await import("@/server/errors/types");

    let fromTs: Date | undefined;
    if (input.from) {
      fromTs = new Date(input.from);
      if (Number.isNaN(fromTs.getTime())) {
        throw validationError("Invalid `from` date", [
          { field: "from", message: "must be an ISO 8601 date string" },
        ]);
      }
    }

    const result = await verifyAuditLogChain(getDb(), fromTs ? { fromTs } : {});
    if (result.valid) {
      return { ok: true as const, count: result.count };
    }
    return {
      ok: false as const,
      count: result.count,
      brokenAt: {
        id: result.brokenAt.id,
        occurredAt:
          result.brokenAt.occurredAt instanceof Date
            ? result.brokenAt.occurredAt.toISOString()
            : String(result.brokenAt.occurredAt),
        reason: result.brokenAt.reason,
      },
    };
  },
});
export const verifyAudit = createServerFn({ method: "GET" })
  .middleware([verifyAuditGate])
  .handler(serverFnNoop);
