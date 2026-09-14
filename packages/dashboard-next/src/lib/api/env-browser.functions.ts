/**
 * Env-browser — server functions (WP-18). SECURITY-SENSITIVE (secret reveal).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/audit + the business handler. All server-only logic (PAM, the
 * reveal-grant store, errors) is imported DYNAMICALLY inside each handler so
 * import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers (read verbatim):
 *   packages/dashboard/src/routes/api/env-browser/+server.ts        (read)
 *   packages/dashboard/src/routes/api/env-browser/unlock/+server.ts (unlock)
 *
 *   - readEnv  GET, auth 'admin' — read an env file from an allowlisted
 *              directory (configured secrets and stacks roots),
 *              resolved through realpath (symlink-escape defence). Values are
 *              MASKED by default; cleartext is returned ONLY when the calling
 *              session holds a LIVE reveal grant. Without a grant the response
 *              never carries a cleartext secret.
 *   - unlock   POST, auth 'admin', rate-limit 5/60s/user — re-prove the CURRENT
 *              operator's identity via their PAM password, then open a 10-minute
 *              reveal window bound to this session. The password is NEVER logged,
 *              stored, echoed, or placed in the audit target; the PAM error is
 *              never forwarded to the client (coarse failure only).
 *
 * Frontend (Wave 2) calls these typed:
 *   await readEnv({ data: { path } })
 *   await unlock({ data: { password } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Allowlist + masking — ported verbatim from the legacy handler. The prefix
// list and SECRET_KEY_RE / maskValue are load-bearing; do not weaken them.
// ---------------------------------------------------------------------------

const SECRET_KEY_RE =
  /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?id|cookie|authorization|bearer)/i;

function maskValue(key: string, value: string): string {
  if (SECRET_KEY_RE.test(key)) {
    if (value.length <= 4) return "••••";
    return `••••••••${value.slice(-4)}`;
  }
  if (value.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
    return `••••••••${value.slice(-4)}`;
  }
  return value;
}

/**
 * Resolve symlinks then verify the result still lands under an allowed prefix.
 *
 * When `realpath` SUCCEEDS, the resolved path is authoritative — a symlink or
 * `..` traversal that resolves OUTSIDE the allowlist is rejected even if the
 * literal request string happened to start with an allowed prefix (the de-slop
 * fix: the legacy literal-prefix fallback let traversal escape the root).
 * Missing or unreadable targets fail closed.
 */
async function resolveEnvPath(path: string): Promise<string | null> {
  const { realpath, stat } = await import("node:fs/promises");
  const { dashboardPaths, canonicalRoots, isWithinRoot } = await import("@/server/paths");
  const config = dashboardPaths();
  const roots = await canonicalRoots([config.secrets, config.stacks]);
  try {
    const resolved = await realpath(path);
    if (!roots.some((root) => isWithinRoot(resolved, root))) return null;
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export const listEnvFilesGateOptions: ServerFnOptions<
  Record<string, never>,
  { files: string[] }
> = {
  method: "GET",
  auth: "admin",
  input: z.object({}).strict(),
  surface: "env-browser",
  action: "env-browser.list",
  handler: async () => {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { dashboardPaths, canonicalRoots } = await import("@/server/paths");
    const config = dashboardPaths();
    const roots = await canonicalRoots([config.secrets, config.stacks]);
    const files = new Set<string>();
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8 || files.size >= 2000) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.size >= 2000) break;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.name === ".env" || entry.name.endsWith(".env")) {
          const resolved = await resolveEnvPath(path);
          if (resolved) files.add(resolved);
        }
      }
    }
    for (const root of roots) await walk(root, 0);
    return { files: [...files].sort() };
  },
};
const listEnvFilesGate = defineServerFn(listEnvFilesGateOptions);
export const listEnvFiles = createServerFn({ method: "GET" })
  .middleware([listEnvFilesGate])
  .handler(serverFnNoop);

interface EnvEntry {
  key: string;
  value: string;
  masked: string;
}

async function readEnvFile(path: string): Promise<EnvEntry[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n");
  const entries: EnvEntry[] = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eq = trimmed.indexOf("=");
      if (eq !== -1) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        entries.push({ key, value, masked: maskValue(key, value) });
      }
    }
  });
  return entries;
}

/**
 * Replace a single `KEY=value` line in an env file, preserving every other line
 * (comments, blanks, ordering). Quotes the value when it contains whitespace or
 * shell-significant characters. Writes atomically (tmp + rename) so a torn write
 * can never leave the file — which may be the dashboard's own creds — corrupt.
 * Returns false if the key was not present.
 */
export async function writeEnvValue(path: string, key: string, value: string): Promise<boolean> {
  const { readFile, writeFile, rename } = await import("node:fs/promises");
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n");
  let found = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1 || trimmed.slice(0, eq).trim() !== key) return line;
    found = true;
    const lead = line.slice(0, line.indexOf(trimmed));
    const needsQuote = value === "" || /[\s#"'$`\\]/.test(value);
    const v = needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
    return `${lead}${key}=${v}`;
  });
  if (!found) return false;
  const tmp = `${path}.cortex-tmp`;
  await writeFile(tmp, next.join("\n"), { mode: 0o600 });
  await rename(tmp, path);
  return true;
}

// ---------------------------------------------------------------------------
// readEnv — GET, auth: admin → { path, revealed, revealExpiresAt, entries }
//
// Cleartext is gated behind a PAM-verified reveal window bound to this session
// (see `unlock`). When the window is closed, every entry's `value` is the masked
// string — no secret ever leaves the server without an active grant.
// ---------------------------------------------------------------------------

const ReadEnvInput = z.object({ path: z.string().min(1).max(2048) }).strict();

type ReadEnvInputT = z.infer<typeof ReadEnvInput>;

interface ReadEnvOutput {
  path: string;
  revealed: boolean;
  revealExpiresAt: number | null;
  entries: { key: string; value: string; masked: string }[];
}

/**
 * readEnv gate options. Exported so the node-env test can drive the REAL handler
 * through the `defineApiRoute` pipeline (the createServerFn transform only runs
 * in the Vite/Nitro build) — a single source of truth for the gate + handler.
 */
export const readEnvGateOptions: ServerFnOptions<ReadEnvInputT, ReadEnvOutput> = {
  method: "GET",
  auth: "admin",
  input: ReadEnvInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "env-browser",
  action: "env-browser.read",
  // Audit target is the requested path (safe — never a value).
  target: (input) => input.path,
  handler: async ({ input, ctx }) => {
    const { notFoundError, permissionError } = await import("@/server/errors/types");
    const { hasRevealGrant, revealExpiresAt } = await import("@/server/env-reveal");

    const resolved = await resolveEnvPath(input.path);
    if (!resolved) {
      throw permissionError(`Path not in allowlist: ${input.path}`);
    }

    let entries: EnvEntry[];
    try {
      entries = await readEnvFile(resolved);
    } catch {
      throw notFoundError(`Env file not found: ${input.path}`, "env_file");
    }

    // Cleartext only when this session holds a live reveal grant.
    const sessionId = ctx.session?.id ?? null;
    const revealed = hasRevealGrant(sessionId);

    return {
      path: input.path,
      revealed,
      revealExpiresAt: revealed ? revealExpiresAt(sessionId) : null,
      entries: entries.map(({ key, value, masked }) => ({
        key,
        value: revealed ? value : masked,
        masked,
      })),
    };
  },
};
const readEnvGate = defineServerFn(readEnvGateOptions);
export const readEnv = createServerFn({ method: "GET" })
  .middleware([readEnvGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// unlock — POST, auth: admin, rate-limit 5/60s/user → { ok, expiresAt, ttlSec }
//
// Step-up auth: re-prove the CURRENT operator's PAM password, then open a
// 10-minute reveal window bound to THIS session. The password is never logged
// or placed in the audit target; the PAM error is never surfaced (coarse
// failure only — no user-enumeration, T-101).
// ---------------------------------------------------------------------------

const UnlockInput = z.object({ password: z.string().min(1).max(1024) }).strict();

type UnlockInputT = z.infer<typeof UnlockInput>;

interface UnlockOutput {
  ok: true;
  expiresAt: number;
  ttlSec: number;
}

/** unlock gate options (exported for the node-env test — see readEnvGateOptions). */
export const unlockGateOptions: ServerFnOptions<UnlockInputT, UnlockOutput> = {
  method: "POST",
  auth: "admin",
  input: UnlockInput,
  // Per-user bucket so one user cannot lock out another via a shared IP.
  rateLimit: { limit: 5, windowSec: 60, bucket: "user" },
  surface: "env-browser",
  action: "env-browser.unlock",
  // NB: never put the password (or any derivative) in the audit target.
  target: () => null,
  handler: async ({ input, user, ctx }) => {
    const { getPamAuthenticator } = await import("@/server/auth/pam");
    const { authError } = await import("@/server/errors/types");
    const { grantReveal, REVEAL_TTL_SEC } = await import("@/server/env-reveal");

    const sessionId = ctx.session?.id ?? null;
    if (!sessionId || !user) {
      throw authError("No active session");
    }

    // Re-verify the CURRENT operator's PAM password. `input.password` is the
    // only place the secret lives — it is never logged or echoed.
    const result = await getPamAuthenticator().authenticate(user.username, input.password);
    if (!result.ok) {
      // Coarse failure only — do not distinguish bad-password from other PAM
      // reasons to the client (T-101). The PAM error detail is never surfaced.
      throw authError("Password verification failed");
    }

    const expiresAt = grantReveal(sessionId);
    return { ok: true as const, expiresAt, ttlSec: REVEAL_TTL_SEC };
  },
};

const unlockGate = defineServerFn(unlockGateOptions);
export const unlock = createServerFn({ method: "POST" })
  .middleware([unlockGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// updateEnv — POST, auth: admin, rate-limit 20/60s/user → { ok }
//
// Writes a single KEY=value back to an allowlisted env file. Requires a LIVE
// reveal grant — the same PAM step-up that reveals secrets — so a masked file
// can never be blind-edited. The value is never logged or placed in the audit
// target (only the path + key, both non-secret).
// ---------------------------------------------------------------------------

const UpdateEnvInput = z
  .object({
    path: z.string().min(1).max(512),
    key: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid env key"),
    value: z.string().max(8192),
  })
  .strict();

type UpdateEnvInputT = z.infer<typeof UpdateEnvInput>;

interface UpdateEnvOutput {
  ok: true;
}

export const updateEnvGateOptions: ServerFnOptions<UpdateEnvInputT, UpdateEnvOutput> = {
  method: "POST",
  auth: "admin",
  input: UpdateEnvInput,
  rateLimit: { limit: 20, windowSec: 60, bucket: "user" },
  surface: "env-browser",
  action: "env-browser.update",
  target: (input) => `${input.path} (${input.key})`,
  handler: async ({ input, ctx }) => {
    const { notFoundError, permissionError } = await import("@/server/errors/types");
    const { hasRevealGrant } = await import("@/server/env-reveal");

    const sessionId = ctx.session?.id ?? null;
    if (!hasRevealGrant(sessionId)) {
      throw permissionError("Unlock the file (re-enter your password) before editing.");
    }
    const resolved = await resolveEnvPath(input.path);
    if (!resolved) {
      throw permissionError(`Path not in allowlist: ${input.path}`);
    }

    // Capture the OLD raw value BEFORE writing so we can record a hashed
    // before/after attribution record. A missing file still proceeds to the
    // existing not-found path below (writeEnvValue will throw / return false).
    let oldValue: string | undefined;
    try {
      const existing = await readEnvFile(resolved);
      oldValue = existing.find((e) => e.key === input.key)?.value;
    } catch {
      oldValue = undefined;
    }

    const ok = await writeEnvValue(resolved, input.key, input.value);
    if (!ok) throw notFoundError(`Key '${input.key}' not found in ${input.path}`, "env_key");

    // Durable attribution record — store HASH + LENGTH only (never cleartext)
    // so secret edits are attributable. Best-effort: the write already
    // succeeded, so a DB failure here must never surface to the caller.
    try {
      const { createHash } = await import("node:crypto");
      const { getDb } = await import("@/server/db/client");
      const { appendAuditLog } = await import("@/server/db/repos/audit");
      const sha = (s: string) => createHash("sha256").update(s).digest("hex");
      await appendAuditLog(getDb(), {
        eventType: "env-browser.update.value",
        source: "env-browser",
        subject: `${input.path} (${input.key})`,
        actor: ctx.user?.id != null ? String(ctx.user.id) : null,
        payload: {
          path: input.path,
          key: input.key,
          oldHash: oldValue != null ? sha(oldValue) : null,
          oldLen: oldValue != null ? oldValue.length : null,
          newHash: sha(input.value),
          newLen: input.value.length,
        },
      });
    } catch {
      // best-effort attribution record; the write already succeeded
    }

    return { ok: true as const };
  },
};

const updateEnvGate = defineServerFn(updateEnvGateOptions);
export const updateEnv = createServerFn({ method: "POST" })
  .middleware([updateEnvGate])
  .handler(serverFnNoop);
