/**
 * Notes — markdown editor server functions (Phase 5).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic is
 * imported DYNAMICALLY inside each handler so import-protection never sees
 * `@/server/**` in the client bundle (same convention as systemd.functions.ts
 * — the static-import rule does not apply here: a static `@/server/**` import
 * would leak server code into the client bundle).
 *
 * Roots: ONLY the configured docs and prompts directories. Every read/write
 * resolves the path (realpath, symlink-escape defence — same approach as
 * env-browser's isPathAllowed) and REJECTS anything escaping both roots.
 *
 * Frontend calls these typed:
 *   await listMdFiles()
 *   await readMdFile({ data: { path } })
 *   await writeMdFile({ data: { path, content } })
 */

import type { Dirent } from "node:fs";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Roots + path guard
// ---------------------------------------------------------------------------

async function notesRoots(): Promise<{ docs: string[]; prompts: string[] }> {
  const { dashboardPaths, canonicalRoots } = await import("@/server/paths");
  const paths = dashboardPaths();
  return { docs: await canonicalRoots([paths.docs]), prompts: await canonicalRoots([paths.prompts]) };
}

/**
 * Resolve symlinks then verify the result still lands under a notes root.
 * Ported from env-browser's isPathAllowed: when `realpath` succeeds the
 * resolved path is the SOLE source of truth (a symlink or `..` traversal that
 * escapes the roots is rejected even if the literal string started with one).
 * Falls back to a literal normalized check only when the file does not exist
 * yet (new file) — any traversal segment is rejected in that branch.
 */
async function resolveNotesPath(path: string): Promise<string | null> {
  const { realpath } = await import("node:fs/promises");
  const { resolve, dirname } = await import("node:path");
  const { isWithinRoot } = await import("@/server/paths");
  const configured = await notesRoots();
  const roots = [...configured.docs, ...configured.prompts];
  try {
    const resolved = await realpath(path);
    return roots.some((root) => isWithinRoot(resolved, root)) ? resolved : null;
  } catch {
    // File absent (new note) — normalize the literal path and also verify the
    // parent directory so a symlinked parent cannot smuggle the write out.
    if (path.includes("..")) return null;
    const normalized = resolve(path);
    if (!roots.some((root) => isWithinRoot(normalized, root))) return null;
    try {
      const parent = await realpath(dirname(normalized));
      return roots.some((root) => parent === root || isWithinRoot(parent, root)) ? normalized : null;
    } catch {
      return null;
    }
  }
}

/** Root label for a resolved path: "prompts" or "docs". */
type NotesRoot = "docs" | "prompts";

/** A markdown file listed by the notes editor. */
export interface MdFileEntryT {
  path: string;
  name: string;
  root: NotesRoot;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const MdPathInput = z
  .object({
    path: z.string().min(1).max(1024),
  })
  .strict();

const WriteMdInput = z
  .object({
    path: z.string().min(1).max(1024),
    content: z.string().max(1_000_000),
  })
  .strict();

// ---------------------------------------------------------------------------
// listMdFiles — GET, auth: admin → { files: { path, name, root }[] }
//
// Recursively lists *.md under both roots (depth 8, 2000 files per root).
// A missing/unreadable root is SKIPPED, never thrown.
// ---------------------------------------------------------------------------

export const listMdFilesGateOptions: ServerFnOptions<
  Record<string, never>,
  { files: MdFileEntryT[] }
> = {
  method: "GET",
  auth: "admin",
  input: z.object({}).strict(),
  surface: "notes",
  action: "notes.list",
  handler: async () => {
    const { readdir, realpath } = await import("node:fs/promises");
    const { join, basename } = await import("node:path");
    const { isWithinRoot } = await import("@/server/paths");
    const configured = await notesRoots();
    const roots = [...configured.docs, ...configured.prompts];

    const MAX_DEPTH = 8;
    const MAX_FILES = 2000;

    const files: MdFileEntryT[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip, never throw
      }
      // Deterministic order across platforms.
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          // Resolve so symlinked files report their real path (the guard
          // re-checks this on read/write).
          let path = full;
          try {
            path = await realpath(full);
          } catch {
            /* keep literal */
          }
          if (!roots.some((root) => isWithinRoot(path, root))) continue;
          files.push({
            path,
            name: basename(path),
            root: configured.prompts.some((root) => isWithinRoot(path, root)) ? "prompts" : "docs",
          });
        }
      }
    }

    for (const root of roots) {
      await walk(root, 0);
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files };
  },
};
const listMdFilesGate = defineServerFn(listMdFilesGateOptions);
export const listMdFiles = createServerFn({ method: "GET" })
  .middleware([listMdFilesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// readMdFile — GET, auth: admin → { path, content } | 400 on escape
// ---------------------------------------------------------------------------

/**
 * readMdFile gate options. Exported so the node-env test can drive the REAL
 * handler through the `defineApiRoute` pipeline (single source of truth —
 * same convention as env-browser.functions.ts).
 */
export const readMdFileGateOptions: ServerFnOptions<
  z.infer<typeof MdPathInput>,
  { path: string; content: string }
> = {
  method: "GET",
  auth: "admin",
  input: MdPathInput,
  surface: "notes",
  action: "notes.read",
  target: (input) => input.path,
  handler: async ({ input }) => {
    const { readFile } = await import("node:fs/promises");
    const { validationError, notFoundError } = await import("@/server/errors/types");

    const resolved = await resolveNotesPath(input.path);
    if (!resolved) {
      throw validationError(`Path escapes the notes roots: ${input.path}`, [
        {
          field: "path",
          message: "path must stay under the configured docs or prompts root",
        },
      ]);
    }

    let content: string;
    try {
      content = await readFile(resolved, "utf-8");
    } catch {
      throw notFoundError(`Markdown file not found: ${input.path}`, "md_file");
    }
    return { path: resolved, content };
  },
};
const readMdFileGate = defineServerFn(readMdFileGateOptions);
export const readMdFile = createServerFn({ method: "GET" })
  .middleware([readMdFileGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// writeMdFile — POST, auth: admin, approval: true, rate-limit 20/min/user
//
// Saves a markdown file under one of the two roots. Same traversal guard as
// readMdFile — a resolved path escaping both roots is a 400. Writes
// atomically (tmp + rename, no shell — the systemd.ts-style safety) so a torn
// write never corrupts the target.
// ---------------------------------------------------------------------------

/**
 * writeMdFile gate options (exported for the node-env test — see
 * readMdFileGateOptions).
 */
export const writeMdFileGateOptions: ServerFnOptions<
  z.infer<typeof WriteMdInput>,
  { path: string; bytes: number }
> = {
  method: "POST",
  auth: "admin",
  input: WriteMdInput,
  rateLimit: { limit: 20, windowSec: 60, bucket: "user" },
  surface: "notes",
  action: "notes.write",
  target: (input) => input.path,
  approval: true,
  handler: async ({ input }) => {
    const { writeFile, rename } = await import("node:fs/promises");
    const { validationError } = await import("@/server/errors/types");

    const resolved = await resolveNotesPath(input.path);
    if (!resolved) {
      throw validationError(`Path escapes the notes roots: ${input.path}`, [
        {
          field: "path",
          message: "path must stay under the configured docs or prompts root",
        },
      ]);
    }

    // Atomic write: tmp file in the same directory, then rename.
    const tmp = `${resolved}.cortex-tmp`;
    await writeFile(tmp, input.content, { mode: 0o644 });
    await rename(tmp, resolved);
    return { path: resolved, bytes: Buffer.byteLength(input.content, "utf-8") };
  },
};
const writeMdFileGate = defineServerFn(writeMdFileGateOptions);
export const writeMdFile = createServerFn({ method: "POST" })
  .middleware([writeMdFileGate])
  .handler(serverFnNoop);
