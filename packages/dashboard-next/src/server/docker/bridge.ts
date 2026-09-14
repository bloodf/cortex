/**
 * Docker bridge — allowlist-gated dispatch (WP-11).
 *
 * Ported from:
 *   packages/dashboard/src/lib/server/docker/bridge.ts
 *
 * The UI submits an allowlisted op (e.g. `docker.start`) with typed args;
 * `dispatch()` re-runs PB-2 (no `bash -c <userstring>`), PB-5 (approval
 * token required), maps the op to a fixed argv via the policy allowlist,
 * and shells out via `execFile` (no shell, no string interpolation).
 *
 * PB-2 (SR-019) is enforced at two layers:
 *   - Op-level: `allowlistedCommand('bash -c id')` is undefined → 400.
 *   - Bridge-level: resolved argv scanned for literal `bash -c` pair +
 *     args object scanned for shell metacharacters (T-104).
 *
 * PB-5: every op requires an approval token. `dispatch()` verifies + consumes
 * it internally using the approval module's `verifyApproval`/`consumeApproval`.
 *
 * Executor swap: production requires the real Linux Docker CLI.
 * CORTEX_DOCKER_BRIDGE_REAL=0 is permitted only in NODE_ENV=test.
 * Tests can swap the executor via `setExecutorForTests`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  allowlistedCommand,
  hasSmugglingPattern,
  validateShellArg,
  listAllowlistedBySurface,
  type AllowlistEntry,
} from "../policy";
import { audit } from "../audit";
import type { User } from "../entities";
import { actionHashFor } from "../approval";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the bridge call. Mirrors the route input but does not trust it. */
export interface DispatchInput {
  /** The op name from the allowlist (e.g. `docker.start`). */
  op: string;
  /** Keyed arguments; values are strings, numbers, booleans, or nested objects. */
  args: Readonly<Record<string, unknown>>;
  /**
   * Approval token. Required for every op — PB-5 says even the "safe" ones
   * get the gate so the wiring is proven end-to-end.
   */
  approvalToken?: string | null;
  /** Caller's session id — for approval-token session binding. */
  sessionId?: string | null;
}

/** Caller context (who + where). The route provides this. */
export interface DispatchContext {
  user: User;
  ip: string;
  userAgent: string | null;
  requestId: string;
}

/** The structured result the bridge returns. */
export type DispatchResult =
  | {
      status: "accepted";
      op: string;
      argv: readonly string[];
      durationMs: number;
      output: string;
    }
  | {
      status: "rejected";
      op: string;
      code:
        | "unknown_op"
        | "arg_smuggling"
        | "argv_bash_c"
        | "arg_type"
        | "argv_render"
        | "placeholder_unbound"
        | "leading_dash"
        | "missing_approval"
        | "invalid_approval"
        | "executor_error";
      reason: string;
      field?: string;
    };

/**
 * Executor — the part M3 swaps for the real docker socket or
 * `executeRootCommand`. Signature is kept tiny so the bridge is
 * trivially testable.
 */
export type Executor = (argv: readonly string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

// ---------------------------------------------------------------------------
// Default executor
// ---------------------------------------------------------------------------

const M2_STUB_MARKER = "__cortexos_docker_bridge_stub__";

/** Real executor — `docker <argv...>` via execFile (no shell). */
const realDockerExecutor: Executor = async (argv) => {
  const [program, ...args] = argv;
  if (!program) {
    return { stdout: "", stderr: "empty argv", exitCode: 2 };
  }
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "docker exec failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

if (process.env.NODE_ENV !== "test") {
  if (process.env.CORTEX_DOCKER_BRIDGE_REAL === "0") {
    throw new Error("CORTEX_DOCKER_BRIDGE_REAL=0 is test-only; remove it to use Docker");
  }
  if (process.platform !== "linux") throw new Error("Docker bridge requires Linux");
}

const defaultExecutor: Executor =
  process.env.CORTEX_DOCKER_BRIDGE_REAL === "0" ||
  process.platform === "win32" ||
  (process.platform === "darwin" && process.env.CORTEX_DOCKER_BRIDGE_REAL !== "1")
    ? async (argv) => ({
        stdout: `${M2_STUB_MARKER} ${argv.join(" ")}`,
        stderr: "",
        exitCode: 0,
      })
    : realDockerExecutor;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let executor: Executor = defaultExecutor;

/** Test helper: swap the executor. Pass `null` to reset. */
export function setExecutorForTests(fn: Executor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Docker executor injection is test-only");
  executor = fn ?? defaultExecutor;
}

// ---------------------------------------------------------------------------
// Arg validation — second-line defence (PB-2 / T-104)
// ---------------------------------------------------------------------------

/** Recursively walk an args object and return a flat list of violations. */
function collectArgSmugglingHits(
  value: unknown,
  path: string,
  hits: { field: string; reason: string; matched: string }[],
): void {
  if (typeof value === "string") {
    const r = validateShellArg(value);
    if (!r.ok) hits.push({ field: path, reason: r.reason, matched: r.matched });
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectArgSmugglingHits(value[i], `${path}[${i}]`, hits);
    }
    return;
  }
  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
      collectArgSmugglingHits(v, path ? `${path}.${k}` : k, hits);
    });
  }
}

/**
 * True if the resolved argv contains a literal `bash -c` pair. Belt-and-
 * braces guard for PB-2 / SR-019.
 */
function argvContainsBashDashC(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    const a = argv[i];
    const b = argv[i + 1];
    if (/(^|\/)(bash|sh|zsh|ksh)$/.test(a) && b === "-c") {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Argv rendering
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /^<[a-zA-Z_][a-zA-Z0-9_]*>$/;

function renderArgv(
  entry: AllowlistEntry,
  args: Readonly<Record<string, unknown>>,
):
  | { argv: string[] }
  | {
      code: "placeholder_unbound" | "arg_type" | "leading_dash";
      field: string;
      reason: string;
    } {
  const argv: string[] = [];
  for (let i = 0; i < entry.argv.length; i += 1) {
    const token = entry.argv[i];
    if (PLACEHOLDER_RE.test(token)) {
      const key = token.slice(1, -1);
      const v = args[key];
      if (v === undefined || v === null) {
        return {
          code: "placeholder_unbound",
          field: key,
          reason: `placeholder <${key}> not provided`,
        };
      }
      if (typeof v === "string") {
        // SEC-02: a caller-controlled positional must never start with `-`, or
        // it would be parsed by docker as a flag (flag-spoofing). incus
        // neutralizes this with its name regex and systemd with an existence
        // snapshot; docker did neither, so reject leading-dash values here.
        // The fixed argv tokens (e.g. `--privileged`) bypass this branch —
        // only placeholder-bound values are checked.
        if (/^-/.test(v)) {
          return {
            code: "leading_dash",
            field: key,
            reason: `placeholder <${key}> must not start with '-' (flag-spoofing)`,
          };
        }
        argv.push(v);
      } else if (typeof v === "number" && Number.isFinite(v)) {
        argv.push(String(v));
      } else {
        return {
          code: "arg_type",
          field: key,
          reason: `placeholder <${key}> must be string|number`,
        };
      }
    } else {
      argv.push(token);
    }
  }
  return { argv };
}

// ---------------------------------------------------------------------------
// dispatch — public entry point
// ---------------------------------------------------------------------------

/**
 * Dispatch an allowlisted docker op.
 *
 * PB-5: every op requires a valid approval token. The route mints the token;
 *       the bridge verifies + consumes it.
 * PB-2: `bash -c <userstring>` is rejected at two layers — op-name allowlist
 *       check and rendered-argv scan.
 *
 * @returns a structured `DispatchResult`. Never throws. The handler turns
 *          `rejected` into the right error.
 */
export async function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const t0 = Date.now();

  // 1. Op must be on the allowlist.
  const entry = allowlistedCommand(input.op);
  if (!entry) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "failure",
      errorCode: "unknown_op",
      requestId: ctx.requestId,
      payload: { phase: "allowlist", op: input.op },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "unknown_op",
      reason: `op '${input.op}' is not on the allowlist`,
    };
  }

  // 2. Recursive arg-smuggling scan (PB-2 / T-104).
  const hits: { field: string; reason: string; matched: string }[] = [];
  collectArgSmugglingHits(input.args, "", hits);
  if (hits.length > 0) {
    const first = hits[0];
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "denied",
      errorCode: "arg_smuggling",
      requestId: ctx.requestId,
      payload: { phase: "arg_smuggling", hits },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "arg_smuggling",
      reason: first.reason,
      field: first.field || "_root",
    };
  }

  // 3. Render the argv from the entry's placeholders.
  const rendered = renderArgv(entry, input.args);
  if ("code" in rendered) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "failure",
      errorCode: rendered.code,
      requestId: ctx.requestId,
      payload: { phase: "render", code: rendered.code, field: rendered.field },
    });
    return {
      status: "rejected",
      op: input.op,
      code: rendered.code,
      reason: rendered.reason,
      field: rendered.field,
    };
  }

  // 4. PB-2 belt-and-braces: reject any rendered argv containing `bash -c`.
  if (argvContainsBashDashC(rendered.argv)) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "denied",
      errorCode: "argv_bash_c",
      requestId: ctx.requestId,
      payload: { phase: "argv_bash_c", argv: rendered.argv },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "argv_bash_c",
      reason: "rendered argv contains a literal `bash -c` pair",
    };
  }

  // 5. PB-5: every op requires an approval token.
  if (!input.approvalToken) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "denied",
      errorCode: "missing_approval",
      requestId: ctx.requestId,
      payload: { phase: "approval", argv: rendered.argv },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "missing_approval",
      reason: "approval token is required for every docker op (PB-5)",
    };
  }

  // Compute the canonical action hash so caller and bridge agree.
  const expectedActionHash = actionHashFor(input.op, {
    op: input.op,
    args: { ...input.args },
  });

  // Lazy-import the approval verify to avoid a circular import at module load.
  const { verifyApproval, consumeApproval } = await import("../approval");
  const sessionId = (input.sessionId ?? "") as never;
  const verify = verifyApproval(input.approvalToken, sessionId);
  if (!verify.ok) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "denied",
      errorCode: "invalid_approval",
      requestId: ctx.requestId,
      payload: { phase: "approval", reason: verify.reason, expectedActionHash },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "invalid_approval",
      reason: `approval token rejected: ${verify.reason}`,
    };
  }

  // Action hash check — the token must be bound to this specific op+args.
  if (verify.claims.actionHash !== expectedActionHash) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.reject",
      target: input.op,
      result: "denied",
      errorCode: "invalid_approval",
      requestId: ctx.requestId,
      payload: {
        phase: "approval",
        reason: "action_hash_mismatch",
        expectedActionHash,
        actual: verify.claims.actionHash,
      },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "invalid_approval",
      reason: "approval token action-hash mismatch (PB-5: token bound to a different op or args)",
    };
  }

  // Consume the token so it cannot be reused.
  const consumed = consumeApproval(input.approvalToken, sessionId);
  if (!consumed.ok) {
    return {
      status: "rejected",
      op: input.op,
      code: "invalid_approval",
      reason: `approval token rejected on consume: ${consumed.reason}`,
    };
  }

  // 6. Dispatch via executor.
  let dispatchOutcome: "success" | "failure" = "success";
  let output = "";
  try {
    const result = await executor(rendered.argv);
    output = result.stdout;
    if (result.exitCode !== 0) {
      dispatchOutcome = "failure";
    }
  } catch (e) {
    dispatchOutcome = "failure";
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "docker",
      action: "docker.bridge.dispatch",
      target: input.op,
      result: "failure",
      errorCode: "executor_error",
      requestId: ctx.requestId,
      payload: { argv: rendered.argv, error: (e as Error).message },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "executor_error",
      reason: `executor error: ${(e as Error).message}`,
    };
  }

  audit({
    actorUserId: ctx.user.id,
    actorSessionId: null,
    actorIp: ctx.ip,
    actorUserAgent: ctx.userAgent,
    surface: "docker",
    action: "docker.bridge.dispatch",
    target: input.op,
    result: dispatchOutcome,
    errorCode: null,
    requestId: ctx.requestId,
    payload: { argv: rendered.argv },
  });

  return {
    status: "accepted",
    op: input.op,
    argv: rendered.argv,
    durationMs: Date.now() - t0,
    output,
  };
}

// ---------------------------------------------------------------------------
// listDockerOps — allowlisted docker ops for the UI
// ---------------------------------------------------------------------------

export function listDockerOps(): readonly {
  op: string;
  description: string;
  requiresApproval: boolean;
  placeholders: readonly string[];
}[] {
  return listAllowlistedBySurface("docker").map((e) => ({
    op: e.name,
    description: e.description,
    requiresApproval: e.requiresApproval,
    placeholders: e.argv.filter((t) => PLACEHOLDER_RE.test(t)).map((t) => t.slice(1, -1)),
  }));
}

// Re-export the policy helper for the test surface.
export { hasSmugglingPattern };

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Test helper: peek at the default-stub marker. */
export const STUB_MARKER = M2_STUB_MARKER;

/** Test helper: re-export internals for the unit test. */
export const internals = {
  collectArgSmugglingHits,
  argvContainsBashDashC,
  renderArgv,
  hasSmugglingPattern,
};
