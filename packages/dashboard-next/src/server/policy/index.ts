/**
 * Command policy — allowlist + denylist for privileged operations.
 *
 * Implements THREAT_MODEL §4:
 *   - P4: No `bash -c <userstring>` from the UI. Ever.
 *   - §4.4: per-surface named-operation allowlists.
 *   - §4.5: defence-in-depth denylist (catches obvious bad patterns).
 *   - §7.2.2 / T-104: arg-smuggling detection (shell metachars, sub-shell
 *     patterns) is enforced at the schema-validation step BEFORE the
 *     policy.class check.
 *
 * M1: in-memory config. M3: load from `policy.json` (signed, SR-103).
 *
 * Public API:
 *   - allowlistedCommand(name) → AllowlistEntry | undefined
 *   - isCommandAllowed(name, args) → boolean
 *   - violatesDenylist(args) → DenyHit | null
 *   - validateShellArg(value) → ok | { reason }
 *   - listAllowlistedBySurface(surface) → AllowlistEntry[]
 *   - addAllowlisted(entry) → test helper
 *   - resetPolicy() → test helper
 */

import { dashboardPaths } from "@/server/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Surface = "terminal" | "systemd" | "docker" | "incus" | "packages" | "env-browser";

export interface AllowlistEntry {
  /** Operation name as referenced by the UI (e.g. `term.ps`, `systemd.restart`). */
  readonly name: string;
  /** Which surface this operation belongs to. */
  readonly surface: Surface;
  /** The fixed argv to execute. Placeholders like `<unit>`, `<path>` are
   *  filled in by the route handler from the allowlisted values. */
  readonly argv: readonly string[];
  /** Whether this operation requires an approval token. */
  readonly requiresApproval: boolean;
  /** Human-readable description (for audit + UI). */
  readonly description: string;
}

export interface DenyHit {
  readonly pattern: string;
  readonly matched: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

const allowlist: Map<string, AllowlistEntry> = new Map();

/** Register an allowlist entry. Idempotent. */
export function addAllowlisted(entry: AllowlistEntry): void {
  allowlist.set(entry.name, entry);
}

/** Look up an allowlist entry by operation name. */
export function allowlistedCommand(name: string): AllowlistEntry | undefined {
  return allowlist.get(name);
}

/** Convenience: is a name allowlisted at all? */
export function isCommandAllowed(name: string): boolean {
  return allowlist.has(name);
}

/** List all allowlisted operations on a given surface. */
export function listAllowlistedBySurface(surface: Surface): AllowlistEntry[] {
  const out: AllowlistEntry[] = [];
  Array.from(allowlist.values()).forEach((entry) => {
    if (entry.surface === surface) out.push(entry);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

/**
 * Defence-in-depth: matches obvious dangerous patterns. Per THREAT_MODEL §4.5.
 * A hit is logged at WARN; the call is rejected. The denylist is NOT the
 * security control — the allowlist is — but it catches regressions.
 */
const DENY_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+-rf\s+\//, reason: "catastrophic delete at filesystem root" },
  { pattern: /:\(\)\s*\{.*:\|:.*&.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bmkfs\b/, reason: "filesystem creation on a device" },
  { pattern: /\bdd\s+if=.*\b(of|of=)\s*\/dev\/(sd|nvme|hd)/, reason: "disk wipe via dd" },
  { pattern: /\bchmod\s+-R\s+777\s+\//, reason: "permission collapse on /" },
  { pattern: /\bcurl\b.*\|\s*\bbash\b/, reason: "remote code execution via curl|bash" },
  { pattern: /\bwget\b.*-O-\s*\|\s*\bsh\b/, reason: "remote code execution via wget|sh" },
  { pattern: />\/etc\/passwd/, reason: "auth destruction via >/etc/passwd" },
  { pattern: /\bsystemctl\s+mask\b/, reason: "permanent disable via systemctl mask" },
];

/** Sub-shell + arg-smuggling patterns (THREAT_MODEL §7.2.2 / T-104).
 *  These are rejected at the schema-validation step BEFORE the policy.class
 *  check, so even a `free`-class tool can't smuggle them. */
const SMUGGLING_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\$\(/, reason: "command substitution $()" },
  { pattern: /`/, reason: "backtick command substitution" },
  { pattern: /;\s*\w/, reason: "command separator ;" },
  { pattern: /&&/, reason: "command separator &&" },
  { pattern: /\|\|/, reason: "command separator ||" },
  { pattern: /\|(?!\|)/, reason: "pipe |" },
  { pattern: />/, reason: "output redirect >" },
  { pattern: /</, reason: "input redirect <" },
  { pattern: /\\\n/, reason: "line-continuation \\n" },
  { pattern: /\b(bash|sh|zsh|ksh)\s+-c\b/, reason: "explicit bash -c" },
  { pattern: /\beval\b/, reason: "eval()" },
  { pattern: /\bexec\b/, reason: "exec()" },
  { pattern: /\.\.\//, reason: "path traversal ../" },
  { pattern: /\.\.\\/, reason: "path traversal ..\\" },
  { pattern: /[\u200B-\u200D\uFEFF]/, reason: "zero-width Unicode" },
  { pattern: /[‪-‮⁦-⁩]/, reason: "RTL/override Unicode" },
];

/** Returns the first denylist hit in a string, or null. */
export function violatesDenylist(value: string): DenyHit | null {
  for (let i = 0; i < DENY_PATTERNS.length; i += 1) {
    const { pattern, reason } = DENY_PATTERNS[i];
    const m = value.match(pattern);
    if (m) {
      return { pattern: pattern.source, matched: m[0], reason };
    }
  }
  return null;
}

/** Returns the first smuggling-pattern hit in a value, or null. */
export function hasSmugglingPattern(value: string): DenyHit | null {
  for (let i = 0; i < SMUGGLING_PATTERNS.length; i += 1) {
    const { pattern, reason } = SMUGGLING_PATTERNS[i];
    const m = value.match(pattern);
    if (m) {
      return { pattern: pattern.source, matched: m[0], reason };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-arg validation (T-104)
// ---------------------------------------------------------------------------

export type ArgValidationResult =
  { ok: true } | { ok: false; reason: string; pattern: string; matched: string };

/**
 * Validate a single string argument for shell metacharacters and arg-
 * smuggling patterns. Use this in every route's schema validation, before
 * the policy.class check.
 */
export function validateShellArg(value: string): ArgValidationResult {
  const hit = hasSmugglingPattern(value);
  if (hit) {
    return { ok: false, reason: hit.reason, pattern: hit.pattern, matched: hit.matched };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/** Test helper: drop the allowlist (denylist is static). */
export function resetPolicy(): void {
  allowlist.clear();
}

// ---------------------------------------------------------------------------
// Default allowlist (THREAT_MODEL §4.4)
// ---------------------------------------------------------------------------

/**
 * Build the default allowlist per THREAT_MODEL §4.4.
 * Each entry is a named operation; the dashboard maps it to a fixed argv.
 */
export function installDefaultAllowlist(): void {
  // Terminal (§4.4.1)
  addAllowlisted({
    name: "term.read_file",
    surface: "terminal",
    argv: ["cat", "<path>"],
    requiresApproval: false,
    description: "Read a file at an allowlisted path (SR-073).",
  });
  addAllowlisted({
    name: "term.tail_log",
    surface: "terminal",
    argv: ["journalctl", "-u", "<unit>", "-n", "<N>", "--no-pager"],
    requiresApproval: false,
    description: "Tail the journal for an allowlisted unit, last N lines (N <= 1000).",
  });
  addAllowlisted({
    name: "term.ps",
    surface: "terminal",
    argv: ["ps", "auxf"],
    requiresApproval: false,
    description: "Process list.",
  });
  addAllowlisted({
    name: "term.top",
    surface: "terminal",
    argv: ["top", "-b", "-n", "1"],
    requiresApproval: false,
    description: "Top snapshot (one batch iteration, non-interactive).",
  });
  addAllowlisted({
    name: "term.df",
    surface: "terminal",
    argv: ["df", "-h"],
    requiresApproval: false,
    description: "Disk usage.",
  });
  addAllowlisted({
    name: "term.fzf",
    surface: "terminal",
    argv: ["fzf", "<query>"],
    requiresApproval: false,
    description: "Fuzzy-finder (junegunn/fzf) — optional initial <query>.",
  });
  addAllowlisted({
    name: "term.ls",
    surface: "terminal",
    argv: ["ls", "-la", "<path>"],
    requiresApproval: false,
    description: "List directory contents.",
  });
  addAllowlisted({
    name: "term.cat",
    surface: "terminal",
    argv: ["cat", "<path>"],
    requiresApproval: false,
    description: "Read a file.",
  });

  // systemd (§4.4.2)
  ["start", "stop", "restart", "reload", "status", "enable", "disable", "list-units"].forEach(
    (action) => {
      addAllowlisted({
        name: `systemd.${action}`,
        surface: "systemd",
        argv: ["/usr/bin/systemctl", action, "<unit>"],
        requiresApproval: ["restart", "stop"].includes(action),
        description: `systemd ${action} on an allowlisted unit.`,
      });
    },
  );

  // Docker (§4.4.3)
  // SEC-02: each template inserts a literal `--` end-of-options token before
  // the first caller-controlled positional so docker never parses a
  // `<container>`/`<command>` value as a flag (flag-spoofing). The bridge's
  // renderArgv also rejects leading-dash placeholder values — belt and braces.
  ["start", "stop", "restart", "rm", "logs", "inspect", "list"].forEach((action) => {
    addAllowlisted({
      name: `docker.${action}`,
      surface: "docker",
      argv: ["/usr/bin/docker", action, "--", "<container>"],
      requiresApproval: ["rm", "restart", "stop"].includes(action),
      description: `docker ${action} on an allowlisted container.`,
    });
  });
  addAllowlisted({
    name: "docker.privileged",
    surface: "docker",
    argv: ["/usr/bin/docker", "run", "--privileged", "--", "<container>"],
    requiresApproval: true,
    description: "Run a container in privileged mode (SR-042).",
  });
  addAllowlisted({
    name: "docker.exec",
    surface: "docker",
    argv: ["/usr/bin/docker", "exec", "--", "<container>", "<command>"],
    requiresApproval: true,
    description: "Execute an allowlisted subcommand inside an allowlisted container (PB-2 fix).",
  });

  // Incus (§4.4.4)
  ["start", "stop", "restart", "delete", "launch", "list"].forEach((action) => {
    addAllowlisted({
      name: `incus.${action}`,
      surface: "incus",
      argv: ["/usr/bin/incus", action, "<instance>"],
      requiresApproval: ["delete", "restart", "stop"].includes(action),
      description: `incus ${action} on an allowlisted instance.`,
    });
  });
  addAllowlisted({
    name: "incus.exec-named",
    surface: "incus",
    argv: ["/usr/bin/incus", "exec", "<instance>", "--", "<allowlisted-subcommand>"],
    requiresApproval: false,
    description: "Execute an allowlisted subcommand inside an allowlisted instance (PB-4 fix).",
  });

  // Package install (§4.4.5)
  addAllowlisted({
    name: "pkg.install",
    surface: "packages",
    argv: [`${dashboardPaths().root}/scripts/pkg.sh`, "install", "<package>"],
    requiresApproval: true,
    description: "Install an allowlisted package (SR-060, SR-062).",
  });
}

/** Idempotent: install the default allowlist on first import. */
installDefaultAllowlist();
