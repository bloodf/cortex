/**
 * Incus — server functions (WP-12).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic
 * is imported DYNAMICALLY inside each handler so import-protection never sees
 * `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/incus/instances/+server.ts   (list)
 *   packages/dashboard/src/routes/api/incus/actions/+server.ts      (actions)
 *   packages/dashboard/src/routes/api/incus/[name]/exec-named/+server.ts
 *   packages/dashboard/src/routes/api/incus/[name]/logs/+server.ts
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { IncusShellOp, IncusInstance } from "@cortexos/contracts";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const IncusListInput = z.object({}).strict();

const IncusActionInput = z
  .object({
    action: z.enum(["start", "stop", "restart", "delete", "launch", "list"]),
    name: z.string().min(1).max(64),
    confirmation: z.string().optional(),
    approvalToken: z.string().optional(),
    // Launch-only provisioning fields. Validated again server-side against
    // the image allowlist + numeric bounds in the bridge; they are NOT part
    // of the approval action-hash (which binds `{ name }` only).
    image: z.string().min(1).max(128).optional(),
    cpu: z.coerce.number().int().min(1).max(64).optional(),
    memory: z.coerce.number().int().min(128).max(262144).optional(), // MiB
  })
  .strict();

const IncusExecNamedInput = z
  .object({
    name: z.string().min(1).max(64),
    op: z.string().min(1).max(64),
    args: z.record(z.unknown()).default({}),
  })
  .strict();

const IncusLogsInput = z
  .object({
    name: z.string().min(1).max(64),
    tail: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// listInstances — GET, auth: any → { items: IncusInstance[] }
// ---------------------------------------------------------------------------

export const incusListInstancesGateOptions: ServerFnOptions<
  z.infer<typeof IncusListInput>,
  { items: IncusInstance[] }
> = {
  method: "GET",
  auth: "any",
  input: IncusListInput,
  surface: "incus",
  action: "incus.instances.list",
  handler: async () => {
    const { listInstances } = await import("@/server/incus/bridge");
    const items = await listInstances();
    return { items };
  },
};
const listInstancesGate = defineServerFn(incusListInstancesGateOptions);
export const listInstances = createServerFn({ method: "GET" })
  .middleware([listInstancesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// incusAction — POST, auth: admin, rate-limit 10/min/user
// Destructive actions (stop/restart/delete) → approval:true
// → calls dispatchAction, translates DispatchResult to typed errors
// ---------------------------------------------------------------------------

const incusActionGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: IncusActionInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "incus",
  action: "incus.action",
  target: (input) => `${input.action}:${input.name}`,
  handler: async ({ input, ctx }) => {
    const { dispatchAction } = await import("@/server/incus/bridge");
    const { approvalRequiredError, notFoundError, validationError, permissionError, systemError } =
      await import("@/server/errors/types");

    const result = await dispatchAction(
      {
        action: input.action,
        name: input.name,
        confirmation: input.confirmation,
        image: input.image,
        cpu: input.cpu,
        memory: input.memory,
      },
      {
        user: ctx.user!,
        ip: ctx.clientIp,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
        sessionId: ctx.session?.id ?? "",
        approvalToken: input.approvalToken,
      },
    );

    if (result.status === "accepted") {
      return {
        result: {
          action: result.action,
          name: result.name,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          instance: result.instance,
          durationMs: result.durationMs,
        },
      };
    }

    if (result.status === "approval_required") {
      throw approvalRequiredError(result.actionHash, result.ttlSec);
    }

    // rejected — map code to typed error
    const { code } = result;
    if (code === "unknown_instance" || code === "not_allowlisted") {
      throw notFoundError(result.reason, "instance");
    }
    if (
      code === "confirmation_required" ||
      code === "instance_name_invalid" ||
      code === "instance_exists" ||
      code === "image_invalid" ||
      code === "unknown_op"
    ) {
      throw validationError(result.reason, [{ field: "name", message: result.reason }]);
    }
    if (
      code === "approval_required" ||
      code === "approval_invalid" ||
      code === "approval_expired" ||
      code === "approval_session_mismatch" ||
      code === "approval_already_used"
    ) {
      throw permissionError(result.reason);
    }
    // executor_error
    throw systemError(result.reason);
  },
});
export const incusAction = createServerFn({ method: "POST" })
  .middleware([incusActionGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// execNamed — POST, auth: admin, rate-limit 10/min/user
// Calls dispatchExecNamed with the allowlisted op + args
// ---------------------------------------------------------------------------

const execNamedGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: IncusExecNamedInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "incus",
  action: "incus.exec_named",
  target: (input) => `${input.name}:${input.op}`,
  handler: async ({ input, ctx }) => {
    const { dispatchExecNamed } = await import("@/server/incus/bridge");
    const { notFoundError, validationError, permissionError, systemError } =
      await import("@/server/errors/types");

    // op must be a valid IncusShellOp — cast after allowlist check in bridge
    const result = await dispatchExecNamed(
      input.name,
      {
        op: input.op as IncusShellOp,
        args: input.args,
      },
      {
        user: ctx.user!,
        ip: ctx.clientIp,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      },
    );

    if (result.status === "accepted") {
      return {
        status: "accepted" as const,
        op: result.op,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }

    const { code } = result;
    if (code === "unknown_instance") {
      throw notFoundError(result.reason, "instance");
    }
    if (code === "unknown_op" || code === "arg_type") {
      throw validationError(result.reason, [{ field: "op", message: result.reason }]);
    }
    if (code === "arg_smuggling" || code === "argv_bash_c") {
      throw permissionError(result.reason);
    }
    throw systemError(result.reason);
  },
});
export const execNamed = createServerFn({ method: "POST" })
  .middleware([execNamedGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// instanceLogs — GET, auth: any → { lines: IncusLogLine[] }
// ---------------------------------------------------------------------------

const instanceLogsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: IncusLogsInput,
  surface: "incus",
  action: "incus.logs.list",
  target: (input) => input.name,
  handler: async ({ input }) => {
    const { listInstanceLogs } = await import("@/server/incus/bridge");
    const tail = Math.min(Math.max(input.tail ?? 100, 1), 500);
    const lines = await listInstanceLogs(input.name, tail);
    return { lines };
  },
});
export const instanceLogs = createServerFn({ method: "GET" })
  .middleware([instanceLogsGate])
  .handler(serverFnNoop);
