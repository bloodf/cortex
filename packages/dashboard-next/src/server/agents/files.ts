/**
 * Scoped file operations for Hermes agent profile directories (WP-21).
 *
 * All writes are constrained to the profile's `home` directory.
 * Path traversal is double-checked: once before resolve (reject `..` and
 * absolute paths) and once after resolve (resolved path must be a child of
 * `agentDir`). Both checks are required — skipping either allows symlink or
 * encoded-slash attacks.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/**
 * Validate a caller-supplied filename relative to `agentDir`.
 * Returns the resolved absolute target path.
 * Throws Error('path_traversal') if the path is unsafe.
 * Throws Error('path_traversal') if the path escapes `agentDir`.
 */
export function validateFilePath(agentDir: string, filename: string): string {
  // Belt-and-suspenders: reject before resolve
  if (filename.includes("..") || filename.startsWith("/")) {
    throw new Error("path_traversal");
  }
  const target = path.resolve(agentDir, filename);
  // After resolve: resolved path must still be inside agentDir
  if (!target.startsWith(agentDir + path.sep) && target !== agentDir) {
    throw new Error("path_traversal");
  }
  return target;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * List non-hidden files in the profile directory (non-recursive).
 * Returns empty array if the directory does not exist.
 */
export function listAgentFiles(agentDir: string): string[] {
  if (!fs.existsSync(agentDir)) return [];
  return fs
    .readdirSync(agentDir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

/**
 * Write `data` to `filename` inside `agentDir`.
 * Creates intermediate directories if needed.
 * Throws Error('path_traversal') if the resolved path escapes `agentDir`.
 */
export function writeAgentFile(agentDir: string, filename: string, data: Buffer): void {
  const target = validateFilePath(agentDir, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

/**
 * Delete `filename` inside `agentDir`.
 * Throws Error('path_traversal') if unsafe.
 * Throws Error('not_found') if the file does not exist.
 */
export function deleteAgentFile(agentDir: string, filename: string): void {
  const target = validateFilePath(agentDir, filename);
  if (!fs.existsSync(target)) throw new Error("not_found");
  fs.unlinkSync(target);
}

// ---------------------------------------------------------------------------
// Recursive read for the Inspect dialog
// ---------------------------------------------------------------------------

export interface AgentFile {
  /** Path relative to the profile home (POSIX separators). */
  path: string;
  content: string;
  language: string;
  bytes: number;
}

const MAX_FILE_BYTES = 256 * 1024; // skip anything bigger; keeps the payload sane
const MAX_TOTAL_FILES = 200;

/** Directory names that hold caches / runtime junk / SECRETS — never shown. */
const SKIP_DIRS = new Set([
  "node_modules",
  "audio_cache",
  "image_cache",
  "models_dev_cache",
  "sandboxes",
  "logs",
  "__pycache__",
  ".git",
  "bin",
  "venv",
  "pairing",
  // secret / credential stores — MUST never be read into the UI
  "mcp-tokens",
  "tokens",
  "secrets",
  "auth",
  "credentials",
  ".secrets",
  "keys",
]);

/** Filenames (case-insensitive) that hold credentials — never read. */
const SECRET_NAME_RE =
  /(token|secret|cred|oauth|apikey|api[-_]?key|password|\.pem|\.key|channel_directory)/i;

/** Extensions / names that are binary or secret — never read into the UI. */
const SKIP_EXT = new Set([
  ".db",
  ".db-shm",
  ".db-wal",
  ".sqlite",
  ".lock",
  ".pid",
  ".pyc",
  ".so",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".wav",
  ".mp3",
  ".ogg",
  ".zip",
  ".gz",
  ".tar",
  ".bin",
  ".env",
]);

/** Defense-in-depth: mask credential-shaped substrings in returned content. */
function redactContent(text: string): string {
  return text
    .replace(/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, "[REDACTED]")
    .replace(/\bATATT[A-Za-z0-9_=-]{20,}\b/g, "[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9]{36,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "[REDACTED]")
    .replace(
      /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
      "[REDACTED-JWT]",
    )
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi, "Bearer [REDACTED]")
    .replace(
      /("?(?:api[_-]?key|token|secret|password|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*[:=]\s*)"?[^\s",}]{8,}"?/gi,
      "$1[REDACTED]",
    );
}

function languageFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".json") return "json";
  if (ext === ".md") return "markdown";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".mjs") return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".sh") return "bash";
  if (ext === ".toml") return "toml";
  return "text";
}

/**
 * Recursively read the human-readable files under a profile home for the Inspect
 * dialog. Skips cache/log/binary/secret files and directories, caps each file at
 * MAX_FILE_BYTES and the set at MAX_TOTAL_FILES. Returns files sorted by path.
 * Never throws on a missing dir — returns []. Binary content (NUL byte) is
 * dropped defensively even if the extension slipped through.
 */
export function readAgentFiles(agentDir: string): AgentFile[] {
  if (!fs.existsSync(agentDir)) return [];
  const out: AgentFile[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_TOTAL_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_TOTAL_FILES) return;
      if (e.name.startsWith(".")) continue; // hidden (.env, .update_check, …)
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip cache/junk by exact name AND anything credential-shaped
        // (mcp_tokens, oauth-store, api-keys, …) by pattern.
        if (SKIP_DIRS.has(e.name) || SECRET_NAME_RE.test(e.name)) continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      if (SECRET_NAME_RE.test(e.name)) continue; // credential-named file
      if (/\.bak[.-]/i.test(e.name) || e.name.includes(".bak")) continue; // config backups
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // binary
      out.push({
        path: path.relative(agentDir, abs).split(path.sep).join("/"),
        content: redactContent(content),
        language: languageFor(e.name),
        bytes: stat.size,
      });
    }
  };
  walk(agentDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
