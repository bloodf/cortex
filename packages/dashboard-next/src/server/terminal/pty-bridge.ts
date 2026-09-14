/**
 * Terminal PTY bridge — server-side allowlisted op dispatcher (WP-19).
 *
 * Ported from the legacy SvelteKit module
 * `packages/dashboard/src/lib/server/terminal/pty-bridge.ts`, with the legacy
 * M2 stub executor (the placeholder-marker executor) REMOVED. This module ships
 * the real named-op execution path:
 *
 *   1. A server function (`src/lib/api/terminal.functions.ts`) submits
 *      `{ op, args }` to `dispatch(input, ctx)`.
 *   2. `dispatch()` re-runs the policy / arg-smuggling / argv-render guards
 *      (defence in depth — the gate already validated), then maps `op` → argv
 *      via `allowlistedCommand`, fills `<placeholder>` slots from the keyed
 *      `args`, and hands the fixed argv to the executor.
 *   3. The executor is `execFile(cmd, argv, …)` — NO shell, fixed argv array
 *      (PB-2 / T-104). Production requires the real Linux executor.
 *      Deterministic mock executors are available only in NODE_ENV=test.
 *
 * Security invariants (THREAT_MODEL §4.4.1, PB-2, T-104):
 *   - No `bash -c <userstring>` from the UI, ever — enforced by the allowlist
 *     (the op name must be a policy entry) AND a belt-and-braces rejection of
 *     any rendered argv that still contains a literal `<shell> -c` pair.
 *   - Every string arg is scanned with `validateShellArg` (shell metacharacters
 *     + sub-shell patterns) BEFORE argv construction.
 *   - The executor is `execFile`, never `exec`/`spawn`-with-a-shell.
 *
 * Interactive PTY (`spawnPty`): the legacy SvelteKit app upgraded `GET
 * /api/terminal` to a WebSocket and bridged an xterm frontend to a `node-pty`
 * shell. This framework (`@tanstack/react-start@1.168`, Nitro node-server) has
 * NO HTTP/WebSocket route mechanism we can register (see
 * docs/rebuild/ADR-001-server-transport.md) and `node-pty` is a native addon
 * not yet in the dependency set (native deps need the build allowlist —
 * flagged in docs/rebuild/STATUS.md WP-19). `spawnPty` is therefore declared
 * (allowlisted shells, fixed argv, no shell injection) but loads `node-pty`
 * lazily and throws `pty_unavailable` until both the dependency and a streaming
 * transport land. The named-op POST path above is fully real and shippable.
 *
 * The bridge is deterministic on import: no `Date.now()`/`Math.random()` at
 * module scope, no side effects beyond the executor init. Tests swap the
 * executor via `setExecutorForTests`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dashboardPaths } from "@/server/paths";

import {
  allowlistedCommand,
  hasSmugglingPattern,
  listAllowlistedBySurface,
  validateShellArg,
  type AllowlistEntry,
} from "@/server/policy";
import { audit } from "@/server/audit";
import type { User } from "@/server/entities";

// ---------------------------------------------------------------------------
// Constants (preserved from the legacy bridge / WP-19 spec)
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** Shells the interactive PTY is permitted to spawn (WP-19 §3). */
const ALLOWED_SHELLS_LIST = ["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"] as const;
const DEFAULT_SHELL = "/bin/bash";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the bridge call. Mirrors the gate input but does not trust it. */
export interface DispatchInput {
  /** The op name from the allowlist (e.g. `term.ps`). */
  op: string;
  /** Keyed arguments; values are strings, numbers, or nested objects. */
  args: Readonly<Record<string, unknown>>;
}

/** Caller context (who + where). The gate handler provides this. */
export interface DispatchContext {
  user: User;
  ip: string;
  userAgent: string | null;
  requestId: string;
}

/** The structured result the bridge returns. Never throws. */
export type DispatchResult =
  | {
      status: "accepted";
      op: string;
      argv: readonly string[];
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
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
        | "executor_error";
      reason: string;
      /** When code === 'arg_smuggling' the offending field path. */
      field?: string;
    };

/**
 * Executor seam — the part that differs between the real `execFile` path and
 * the deterministic test/non-linux mock. The signature is kept tiny so the
 * bridge is trivially testable.
 */
export type Executor = (argv: readonly string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

// ---------------------------------------------------------------------------
// Real executor (Linux) — execFile with a fixed argv, no shell.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const realExecutor: Executor = async (argv) => {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    return { stdout: "", stderr: "empty argv", exitCode: 1 };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, rest, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "execFile failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

// ---------------------------------------------------------------------------
// Mock executor (non-linux / tests) — deterministic, no process spawn.
// ---------------------------------------------------------------------------

const mockExecutor: Executor = async (argv) => ({
  stdout: `__cortexos_terminal_mock__ ${argv.join(" ")}`,
  stderr: "",
  exitCode: 0,
});

// ---------------------------------------------------------------------------
// Module-level state — the executor is the only swappable piece.
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== "test") {
  if (process.env.CORTEX_TERMINAL_BRIDGE_REAL === "0") {
    throw new Error("CORTEX_TERMINAL_BRIDGE_REAL=0 is test-only; remove it to use terminal operations");
  }
  if (process.platform !== "linux") throw new Error("Terminal bridge requires Linux");
}

let executor: Executor =
  process.platform === "linux" && process.env.CORTEX_TERMINAL_BRIDGE_REAL !== "0"
    ? realExecutor
    : mockExecutor;

/** Test helper: swap the executor. Pass `null` to reset to the default. */
export function setExecutorForTests(fn: Executor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Terminal executor injection is test-only");
  executor =
    fn ??
    (process.platform === "linux" && process.env.CORTEX_TERMINAL_BRIDGE_REAL !== "0"
      ? realExecutor
      : mockExecutor);
}

// ---------------------------------------------------------------------------
// Arg validation — second-line defence (recursive over the keyed args object).
// ---------------------------------------------------------------------------

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
 * Validate every string arg against the shell-safety check. Returns the flat
 * list of violations (empty when all args are safe). Exported for the gate
 * handler's schema-tier check (WP-19 §2).
 */
export function validateAllArgs(
  args: Readonly<Record<string, unknown>>,
): { field: string; reason: string; matched: string }[] {
  const hits: { field: string; reason: string; matched: string }[] = [];
  collectArgSmugglingHits(args, "", hits);
  return hits;
}

/**
 * True if the resolved argv contains a literal `<shell> -c` pair (PB-2
 * belt-and-braces). Catches a future caller that pre-constructs an argv.
 */
function argvContainsBashDashC(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    const a = argv[i];
    const b = argv[i + 1];
    if (/(^|\/)(bash|sh|zsh|ksh)$/.test(a) && b === "-c") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Argv rendering — fill `<placeholder>` tokens with the corresponding arg.
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /^<[a-zA-Z_][a-zA-Z0-9_-]*>$/;

function renderArgv(
  entry: AllowlistEntry,
  args: Readonly<Record<string, unknown>>,
):
  { argv: string[] } | { code: "placeholder_unbound" | "arg_type"; field: string; reason: string } {
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
// dispatch — the public entry point for one-shot named ops.
// ---------------------------------------------------------------------------

/**
 * Dispatch an allowlisted terminal op. Always returns a structured
 * `DispatchResult`; never throws. The gate handler turns a `rejected` result
 * into the right typed error + HTTP status.
 */
export async function dispatch(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const t0 = Date.now();

  // 1. Op must be on the allowlist (gate also checks — defence in depth).
  const entry = allowlistedCommand(input.op);
  if (!entry || entry.surface !== "terminal") {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "terminal",
      action: "terminal.bridge.reject",
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
      reason: `op '${input.op}' is not a terminal allowlist entry`,
    };
  }

  // 2. Recursive arg-smuggling scan.
  const hits = validateAllArgs(input.args);
  if (hits.length > 0) {
    const first = hits[0];
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "terminal",
      action: "terminal.bridge.reject",
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
      surface: "terminal",
      action: "terminal.bridge.reject",
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

  // 4. PB-2 belt-and-braces: reject any rendered argv with a literal `sh -c`.
  if (argvContainsBashDashC(rendered.argv)) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "terminal",
      action: "terminal.bridge.reject",
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
      reason: "rendered argv contains a literal `<shell> -c` pair",
    };
  }

  // 5. Execute (real execFile on Linux; deterministic mock otherwise).
  let out: { stdout: string; stderr: string; exitCode: number };
  try {
    out = await executor(rendered.argv);
  } catch (e) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "terminal",
      action: "terminal.bridge.dispatch",
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
    surface: "terminal",
    action: "terminal.bridge.dispatch",
    target: input.op,
    result: out.exitCode === 0 ? "success" : "failure",
    errorCode: null,
    requestId: ctx.requestId,
    payload: {
      argv: rendered.argv,
      exitCode: out.exitCode,
      stdoutBytes: out.stdout.length,
      stderrBytes: out.stderr.length,
    },
  });

  return {
    status: "accepted",
    op: input.op,
    argv: rendered.argv,
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: out.exitCode,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// listTerminalOps — surface the terminal allowlist for the UI.
// ---------------------------------------------------------------------------

export function listTerminalOps(): readonly {
  op: string;
  description: string;
  requiresApproval: boolean;
  placeholders: readonly string[];
}[] {
  return listAllowlistedBySurface("terminal").map((e) => ({
    op: e.name,
    description: e.description,
    requiresApproval: e.requiresApproval,
    placeholders: e.argv.filter((t) => PLACEHOLDER_RE.test(t)).map((t) => t.slice(1, -1)),
  }));
}

// ---------------------------------------------------------------------------
// spawnPty — interactive PTY shell (BLOCKED on transport + native dep).
// ---------------------------------------------------------------------------

/**
 * The minimal subset of `node-pty`'s `IPty` the streaming transport would use.
 * Declared here so the type compiles WITHOUT `node-pty` in the dependency set
 * (the import is lazy + dynamic; see the function body).
 */
export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  kill(signal?: string): void;
}

/**
 * Spawn an allowlisted interactive shell. The shell is restricted to
 * {@link ALLOWED_SHELLS} (default `/bin/bash`, overridable via
 * `CORTEX_TERMINAL_SHELL` if it is in the allowlist) — `spawn(userInput)` is
 * never reached. Arguments are a fixed empty argv; the client drives the shell
 * over the (future) streaming transport, not by argv.
 *
 * BLOCKED: this framework exposes no WebSocket/SSE route to bridge an xterm
 * client to a live PTY (ADR-001), and `node-pty` is a native addon not yet in
 * package.json (needs the build allowlist — STATUS.md WP-19). Until both land,
 * this throws `pty_unavailable`. The named-op `dispatch` path above is real and
 * shippable; the interactive shell stays mocked in the frontend.
 */
export async function spawnPty(
  shell: string = process.env.CORTEX_TERMINAL_SHELL || DEFAULT_SHELL,
  cols = 80,
  rows = 24,
): Promise<PtyHandle> {
  if (!ALLOWED_SHELLS_LIST.includes(shell as (typeof ALLOWED_SHELLS_LIST)[number])) {
    throw new Error(`shell_not_allowed: ${shell}`);
  }

  let pty: { spawn: (file: string, args: string[], opts: unknown) => PtyHandle };
  try {
    // Dynamic + computed specifier so tsc/Vite never try to resolve the (absent)
    // native addon. node-pty is NOT in package.json yet — adding it needs the
    // build allowlist for the native .node addon (flagged in STATUS.md WP-19).
    const ptyModule = "node-pty";
    pty = await import(/* @vite-ignore */ ptyModule);
  } catch {
    throw new Error(
      "pty_unavailable: node-pty is not installed and this framework has no " +
        "WebSocket/SSE route to stream a live PTY (see docs/rebuild/ADR-001 + STATUS WP-19)",
    );
  }

  return pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: dashboardPaths().home,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
}

/** The allowlisted interactive shells — exposed for tests + the gate. */
export const ALLOWED_SHELLS = ALLOWED_SHELLS_LIST;

/** Internal surfaces for the unit test. */
export const internals = {
  collectArgSmugglingHits,
  argvContainsBashDashC,
  renderArgv,
  hasSmugglingPattern,
};
