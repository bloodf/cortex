/**
 * Alerts — server functions (WP-17).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic
 * (db repos, schema) is imported DYNAMICALLY inside each handler so
 * import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/alerts/+server.ts          (list/create)
 *   packages/dashboard/src/routes/api/alerts/[id]/+server.ts     (read/patch/delete)
 *   packages/dashboard/src/routes/api/alerts/history/+server.ts  (history)
 *
 * Frontend (Wave 2) calls these typed:
 *   await listAlerts({ data: { serviceId, enabledOnly } })
 *   await createAlert({ data: { serviceId, name, condition } })
 *   await getAlert({ data: { id } })
 *   await patchAlert({ data: { id, enabled } })
 *   await deleteAlert({ data: { id } })
 *   await alertHistory({ data: { ruleId, limit } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const AlertListInput = z
  .object({
    serviceId: z.coerce.number().int().positive().optional(),
    enabledOnly: z.coerce.boolean().optional(),
  })
  .strict();

const AlertIdInput = z.object({ id: z.coerce.number().int().positive() }).strict();

const AlertCreateInput = z
  .object({
    serviceId: z.coerce.number().int().positive(),
    name: z.string().min(1).max(255),
    condition: z.enum(["offline", "online", "response_time"]),
    thresholdMs: z.number().int().min(0).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const AlertPatchInput = z
  .object({
    id: z.coerce.number().int().positive(),
    name: z.string().min(1).max(255).optional(),
    condition: z.enum(["offline", "online", "response_time"]).optional(),
    thresholdMs: z.number().int().min(0).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const AlertHistoryInput = z
  .object({
    ruleId: z.coerce.number().int().positive().optional(),
    serviceId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// listAlerts — GET, auth: any → { rules }
// ---------------------------------------------------------------------------

const listGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: AlertListInput,
  surface: "alerts",
  action: "alerts.list",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { listAlertRules } = await import("@/server/db/repos/alerts");
    const rules = await listAlertRules(getDb(), {
      serviceId: input.serviceId,
      enabledOnly: input.enabledOnly ?? false,
    });
    return { rules };
  },
});
export const listAlerts = createServerFn({ method: "GET" })
  .middleware([listGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// createAlert — POST, auth: admin → { rule }
// ---------------------------------------------------------------------------

const createGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: AlertCreateInput,
  surface: "alerts",
  action: "alerts.create",
  target: (input) => input.name,
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { createAlertRule } = await import("@/server/db/repos/alerts");
    const rule = await createAlertRule(getDb(), {
      serviceId: input.serviceId,
      name: input.name,
      condition: input.condition,
      thresholdMs: input.thresholdMs ?? null,
      enabled: input.enabled,
    });
    return { rule };
  },
});
export const createAlert = createServerFn({ method: "POST" })
  .middleware([createGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getAlert — GET, auth: any → { rule } | 404
// ---------------------------------------------------------------------------

const getGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: AlertIdInput,
  surface: "alerts",
  action: "alerts.read",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { getAlertRuleById } = await import("@/server/db/repos/alerts");
    const { notFoundError } = await import("@/server/errors/types");
    const rule = await getAlertRuleById(getDb(), input.id);
    if (!rule) throw notFoundError(`Alert ${input.id} not found`, "alert");
    return { rule };
  },
});
export const getAlert = createServerFn({ method: "GET" })
  .middleware([getGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// patchAlert — POST, auth: admin → { rule } | 404
// ---------------------------------------------------------------------------

const patchGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: AlertPatchInput,
  surface: "alerts",
  action: "alerts.update",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { updateAlertRule } = await import("@/server/db/repos/alerts");
    const { notFoundError } = await import("@/server/errors/types");
    const { id, ...patch } = input;
    const rule = await updateAlertRule(getDb(), id, patch);
    if (!rule) throw notFoundError(`Alert ${id} not found`, "alert");
    return { rule };
  },
});
export const patchAlert = createServerFn({ method: "POST" })
  .middleware([patchGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// deleteAlert — POST, auth: admin → { ok: true } | 404
// ---------------------------------------------------------------------------

const deleteGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: AlertIdInput,
  surface: "alerts",
  action: "alerts.delete",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { deleteAlertRule } = await import("@/server/db/repos/alerts");
    const { notFoundError } = await import("@/server/errors/types");
    const ok = await deleteAlertRule(getDb(), input.id);
    if (!ok) throw notFoundError(`Alert ${input.id} not found`, "alert");
    return { ok: true } as const;
  },
});
export const deleteAlert = createServerFn({ method: "POST" })
  .middleware([deleteGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// alertHistory — GET, auth: any → { history } (newest-first)
// ---------------------------------------------------------------------------

const historyGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: AlertHistoryInput,
  surface: "alerts",
  action: "alerts.history",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { listAlertHistoryWithNames } = await import("@/server/db/repos/alerts");
    const history = await listAlertHistoryWithNames(getDb(), {
      limit: input.limit,
    });
    return { history };
  },
});
export const alertHistory = createServerFn({ method: "GET" })
  .middleware([historyGate])
  .handler(serverFnNoop);

// ===========================================================================
// Notifications (plan 0.5 — real TopBar bell + mark-read)
//
// Source of truth = OPERATIONAL ALERTS (`alerts` table). The TopBar bell maps
// each operational alert to a `DashNotification`-shaped row; `acknowledgedAt`
// (null = unread) is the read flag. Distinct from the rule-based alert feed
// above.
// ===========================================================================

/** Map an operational alert severity to the TopBar's 3-level severity. */
function notificationSeverity(severity: string): "info" | "warn" | "error" {
  if (severity === "error" || severity === "critical") return "error";
  if (severity === "warn") return "warn";
  return "info";
}

// ---------------------------------------------------------------------------
// listNotifications — GET, auth: any → { notifications } (newest first, ≤50)
// ---------------------------------------------------------------------------

const listNotificationsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  surface: "notifications",
  action: "notifications.list",
  handler: async () => {
    const { getDb } = await import("@/server/db/client");
    const { listOperationalAlerts } = await import("@/server/db/repos/alerts");
    const rows = await listOperationalAlerts(getDb(), { limit: 50 });
    const notifications = rows.map((a) => ({
      id: String(a.id),
      title: a.title,
      body: a.body ?? "",
      timestamp: a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
      read: a.acknowledgedAt !== null,
      severity: notificationSeverity(a.severity),
    }));
    return { notifications };
  },
});
export const listNotifications = createServerFn({ method: "GET" })
  .middleware([listNotificationsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// markNotificationsRead — POST, auth: any, CSRF-enforced → { acknowledged }
// Optional `{ ids?: number[] }`; omitted → ack ALL currently-unacknowledged
// operational alerts. Gate options exported so the node-env pipeline test can
// drive the REAL handler against a seeded pglite DB.
// ---------------------------------------------------------------------------

const MarkNotificationsReadInput = z
  .object({
    ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
  })
  .strict();

type MarkNotificationsReadInputT = z.infer<typeof MarkNotificationsReadInput>;

interface MarkNotificationsReadOutput {
  acknowledged: number;
}

export const markNotificationsReadGateOptions: ServerFnOptions<
  MarkNotificationsReadInputT,
  MarkNotificationsReadOutput
> = {
  method: "POST",
  auth: "any",
  input: MarkNotificationsReadInput,
  surface: "notifications",
  action: "notifications.mark_read",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { listOperationalAlerts, acknowledgeOperationalAlert } =
      await import("@/server/db/repos/alerts");
    const { runSequentially } = await import("@/lib/sequential");

    const db = getDb();
    // Resolve the target ids: explicit list, or every currently-unread alert.
    const targetIds =
      input.ids && input.ids.length > 0
        ? input.ids
        : (await listOperationalAlerts(db, { unacknowledgedOnly: true })).map((a) => a.id);

    // Sequential to keep the body lint-clean (no await-in-loop) and avoid
    // hammering the pool; acknowledge is idempotent (already-acked → null).
    const results = await runSequentially(targetIds, (id) => acknowledgeOperationalAlert(db, id));
    const acknowledged = results.filter((r) => r !== null).length;
    return { acknowledged };
  },
};
const markNotificationsReadGate = defineServerFn(markNotificationsReadGateOptions);
export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([markNotificationsReadGate])
  .handler(serverFnNoop);
