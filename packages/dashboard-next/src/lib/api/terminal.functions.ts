/**
 * Terminal — server functions (WP-19).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/audit + the business handler. All server-only logic (the PTY
 * bridge, policy, errors) is imported DYNAMICALLY inside each handler so
 * import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported from the legacy SvelteKit handler
 * `packages/dashboard/src/routes/api/terminal/+server.ts` (GET list-ops +
 * POST named-op dispatch). Admin-only. The legacy WebSocket-upgrade PTY route
 * is NOT ported here: this framework exposes no HTTP/WS route mechanism
 * (ADR-001) and `node-pty` is a native addon not yet in the dependency set
 * (STATUS.md WP-19). The interactive shell stays mocked in the frontend until a
 * streaming transport + the native dep land; the named-op path below is real.
 *
 * Frontend (Wave 2, WP-36) calls these typed:
 *   await listTerminalOps()
 *   await dispatchTerminalOp({ data: { op: "term.ps", args: {} } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schema (mirrors the legacy zod validation — keyed args object).
// ---------------------------------------------------------------------------

const TerminalDispatchInput = z
  .object({
    op: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// listTerminalOps — GET, auth: admin → { ops }
// ---------------------------------------------------------------------------

const listOpsGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: z.object({}).strict(),
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "terminal",
  action: "terminal.list-ops",
  handler: async () => {
    const { listTerminalOps: listOps } = await import("@/server/terminal/pty-bridge");
    return { ops: listOps() };
  },
});
export const listTerminalOps = createServerFn({ method: "GET" })
  .middleware([listOpsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// dispatchTerminalOp — POST, auth: admin, rate-limit 10/min/user
//   → { op, argv, stdout, stderr, exitCode, durationMs }
// ---------------------------------------------------------------------------

const dispatchGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: TerminalDispatchInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "terminal",
  action: "terminal.dispatch",
  target: (input) => input.op,
  handler: async ({ input, user, ctx }) => {
    const { allowlistedCommand } = await import("@/server/policy");
    const { dispatch, validateAllArgs } = await import("@/server/terminal/pty-bridge");
    const { validationError, permissionError } = await import("@/server/errors/types");

    // 1. Allowlist check at the gate boundary (defence in depth). An unknown
    //    op — including any `bash -c <userstring>` — is a 403, never dispatched.
    const entry = allowlistedCommand(input.op);
    if (!entry || entry.surface !== "terminal") {
      throw permissionError(`Unsupported terminal op: ${input.op}`);
    }

    // 2. Arg validation (T-104 schema tier) — shell metacharacters → 400.
    const argHits = validateAllArgs(input.args);
    if (argHits.length > 0) {
      throw validationError(
        "Arg validation failed",
        argHits.map((h) => ({ field: h.field || "_root", message: h.reason })),
      );
    }

    // user is guaranteed non-null: auth:'admin' rejects unauthenticated before here.
    const result = await dispatch(
      { op: input.op, args: input.args },
      {
        user: user!,
        ip: ctx.clientIp ?? "unknown",
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      },
    );

    if (result.status === "rejected") {
      if (result.code === "arg_smuggling" || result.code === "argv_bash_c") {
        throw permissionError(result.reason);
      }
      if (result.code === "unknown_op") {
        throw permissionError(result.reason);
      }
      throw validationError(result.reason, [
        ...(result.field ? [{ field: result.field, message: result.reason }] : []),
        { field: "op", message: result.code },
      ]);
    }

    // status === 'accepted'. A non-zero exitCode is NOT an HTTP error — the
    // client renders the command output (WP-19 §4).
    return {
      op: result.op,
      argv: result.argv,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  },
});
export const dispatchTerminalOp = createServerFn({ method: "POST" })
  .middleware([dispatchGate])
  .handler(serverFnNoop);
