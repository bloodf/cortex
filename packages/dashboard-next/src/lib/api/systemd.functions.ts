/**
 * Systemd — server functions (WP-13).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic is
 * imported DYNAMICALLY inside each handler so import-protection never sees
 * `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/systemd/actions/+server.ts  (dispatch)
 *   packages/dashboard/src/routes/(authed)/systemd/[name]/logs/+server.ts
 *
 * Frontend calls these typed:
 *   await listUnits()
 *   await systemdAction({ data: { action, name } })
 *   await unitLogs({ data: { name, limit } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const SystemdActionInput = z
  .object({
    action: z.enum(["start", "stop", "restart", "reload", "enable", "disable"]),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[A-Za-z0-9_.@-]+$/,
        "unit name must contain only letters, digits, underscores, dots, at-signs, and hyphens",
      ),
  })
  .strict();

const UnitLogsInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.@-]+$/, "unit name must contain only valid characters"),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const UnitNameInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.@-]+$/, "unit name must contain only valid characters"),
  })
  .strict();

// ---------------------------------------------------------------------------
// listUnits — GET, auth: any → { units: SystemdUnit[] }
// ---------------------------------------------------------------------------

const listUnitsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  surface: "systemd",
  action: "systemd.list",
  handler: async () => {
    const { listUnits: bridgeListUnits } = await import("@/server/system/systemd");
    const units = await bridgeListUnits();
    return { units };
  },
});
export const listUnits = createServerFn({ method: "GET" })
  .middleware([listUnitsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getUnit — GET, auth: any → { unit: SystemdUnit } | 404
// ---------------------------------------------------------------------------

const getUnitGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: UnitNameInput,
  surface: "systemd",
  action: "systemd.read",
  target: (input) => input.name,
  handler: async ({ input }) => {
    const { getUnit: bridgeGetUnit } = await import("@/server/system/systemd");
    const { notFoundError } = await import("@/server/errors/types");
    const unit = await bridgeGetUnit(input.name);
    if (!unit) throw notFoundError(`Unit '${input.name}' not found`, "systemd_unit");
    return { unit };
  },
});
export const getUnit = createServerFn({ method: "GET" })
  .middleware([getUnitGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// systemdAction — POST, auth: admin, rate-limit 10/min/user, approval: true
// Destructive actions (stop, restart, disable) require approval (SR-120).
// The pipeline's `approval: true` gate consumes the user-supplied token.
// The handler self-mints a fresh token to pass to dispatchAction so the
// bridge's own approval check is satisfied (same pattern as the legacy
// /api/systemd/actions handler's mintApproval call).
// ---------------------------------------------------------------------------

const systemdActionGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: SystemdActionInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "systemd",
  action: "systemd.action",
  target: (input) => `${input.action}:${input.name}`,
  approval: true,
  handler: async ({ input, user, ctx }) => {
    const { dispatchAction, mintApproval: bridgeMint } = await import("@/server/system/systemd");
    const { validationError, approvalRequiredError } = await import("@/server/errors/types");

    if (!user) throw validationError("Authentication required", []);

    const sessionId = ctx.session?.id ?? ("unknown" as never);
    const policyName = `systemd.${input.action}`;

    // Self-mint an approval token so the bridge's destructive-action gate
    // is satisfied (mirrors legacy +server.ts mintApproval pattern).
    const { token: approvalToken } = bridgeMint({
      action: policyName,
      payload: { name: input.name },
      sessionId,
      userId: String(user.id),
      ttlSec: 60,
    });

    const result = await dispatchAction(
      { action: input.action, name: input.name },
      {
        user,
        ip: ctx.clientIp,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
        sessionId: String(sessionId),
        approvalToken,
      },
    );

    if (result.status === "approval_required") {
      throw approvalRequiredError(result.actionHash, result.ttlSec);
    }
    if (result.status === "rejected") {
      throw validationError(result.reason, [{ field: "action", message: result.code }]);
    }

    return {
      action: result.action,
      name: result.name,
      status: "accepted" as const,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      unit: result.unit,
      durationMs: result.durationMs,
    };
  },
});
export const systemdAction = createServerFn({ method: "POST" })
  .middleware([systemdActionGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// unitLogs — GET, auth: any → { unit, limit, count, lines }
// ---------------------------------------------------------------------------

const unitLogsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: UnitLogsInput,
  surface: "systemd",
  action: "systemd.logs",
  target: (input) => input.name,
  handler: async ({ input }) => {
    const { getUnit: bridgeGetUnit, listLogs } = await import("@/server/system/systemd");
    const { notFoundError } = await import("@/server/errors/types");

    const unit = await bridgeGetUnit(input.name);
    if (!unit) throw notFoundError(`Unit '${input.name}' not found`, "systemd_unit");

    const limit = input.limit ?? 100;
    const lines = await listLogs(input.name, limit);
    return { unit: input.name, limit, count: lines.length, lines };
  },
});
export const unitLogs = createServerFn({ method: "GET" })
  .middleware([unitLogsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// hostLogs — GET, auth: admin, rate-limit 10/min/user (MP-009).
// Returns the most-recent `limit` log lines for the WHOLE host journal
// (no `--unit` filter; no `getUnit` precondition). Same line shape as
// unitLogs: SystemdLogLine[]. Mapped to display text by the client
// (`[ts] PRIO unit: msg`).
// ---------------------------------------------------------------------------

const HostLogsInput = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const hostLogsGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: HostLogsInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "systemd",
  action: "systemd.host.logs",
  handler: async ({ input }) => {
    const { listHostLogs } = await import("@/server/system/systemd");
    const limit = input.limit ?? 100;
    const lines = await listHostLogs(limit);
    return { limit, count: lines.length, lines };
  },
});
export const hostLogs = createServerFn({ method: "GET" })
  .middleware([hostLogsGate])
  .handler(serverFnNoop);
