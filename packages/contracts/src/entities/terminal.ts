/**
 * Terminal entities: TerminalSession, TerminalCommand, EnvLine.
 *
 * The terminal is admin-only and replaces the legacy plaintext shell
 * (M0-B PB-2, T-020). Every command is a named op; raw `bash -c` is
 * banned.
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp, zSha256 } from '../primitives.js';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A live terminal session, server-side state. */
export const TerminalSessionSchema = z.object({
  id: zUuidV4,
  ownerId: zUuidV4,
  /** Connected? Server emits false on disconnect. */
  connected: z.boolean().default(true),
  /** Last activity timestamp; idle > 30min → closed. */
  lastActivityAt: zIsoTimestamp,
  /** Absolute max lifetime (8h per SR-024). */
  expiresAt: zIsoTimestamp,
  /** Encoding for the underlying PTY (when present). */
  encoding: z.enum(['utf-8']).default('utf-8'),
  /** Cols × rows of the client xterm (server tracks last known size). */
  cols: z.number().int().min(8).max(1024).default(80),
  rows: z.number().int().min(8).max(1024).default(24),
});
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

// ---------------------------------------------------------------------------
// Command (named op; SR-020)
// ---------------------------------------------------------------------------

/**
 * The closed set of named terminal ops. Mirrors THREAT_MODEL §4.4.1.
 * Anything outside this set returns 400 with `unsupported_command`.
 */
export const TerminalOpSchema = z.enum([
  'term.ps',
  'term.df',
  'term.ls',
  'term.cat',
  'term.tail_log',
  'term.exec_named',
  'term.disconnect',
]);
export type TerminalOp = z.infer<typeof TerminalOpSchema>;

/** Connect / exec / disconnect envelope. */
export const TerminalActionSchema = z.object({
  action: z.enum(['connect', 'exec', 'disconnect', 'resize']),
  sessionId: zUuidV4,
  /** For `exec`: the named op to run. */
  op: TerminalOpSchema.optional(),
  /** Op-specific args. */
  args: z
    .object({
      path: z.string().min(1).max(512).optional(),
      unit: z.string().min(1).max(128).optional(),
      n: z.number().int().min(1).max(1000).optional(),
      command: z.string().min(1).max(64).optional(),
      data: z.string().min(0).max(4096).optional(),
      cols: z.number().int().min(8).max(1024).optional(),
      rows: z.number().int().min(8).max(1024).optional(),
    })
    .default({}),
});
export type TerminalAction = z.infer<typeof TerminalActionSchema>;

/**
 * A single recorded command in the session's history. The server appends
 * one of these for every `exec` op; the UI renders them in the
 * `IncidentTimeline` or terminal status panel.
 */
export const TerminalCommandSchema = z.object({
  id: zUuidV4,
  sessionId: zUuidV4,
  op: TerminalOpSchema,
  argv: z.array(z.string().min(1).max(512)).default([]),
  exitCode: z.number().int().min(-1).max(255).nullable().optional(),
  startedAt: zIsoTimestamp,
  finishedAt: zIsoTimestamp.nullable().optional(),
  durationMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
});
export type TerminalCommand = z.infer<typeof TerminalCommandSchema>;

// ---------------------------------------------------------------------------
// EnvLine (env-browser output)
// ---------------------------------------------------------------------------

/** A single parsed line of an env file. */
export const EnvLineSchema = z.object({
  /** 1-indexed line number. */
  line: z.number().int().min(1).max(100_000),
  /** Raw line text, including trailing newline. */
  raw: z.string().min(0).max(8192),
  type: z.enum(['kv', 'comment', 'blank']),
  /** Parsed key (when type=kv). */
  key: z.string().min(1).max(256).optional(),
  /** Parsed value (when type=kv); masked by default. */
  value: z.string().max(8192).optional(),
  /** Whether the value is `export FOO=...` syntax. */
  exported: z.boolean().default(false),
  /** Whether the value is masked. False only after reveal + token. */
  masked: z.boolean().default(true),
});
export type EnvLine = z.infer<typeof EnvLineSchema>;

/** The env-browser read response. */
export const EnvFileSchema = z.object({
  /** Resolved path (after `realpath`, post-allowlist check). */
  path: z.string().min(1).max(512),
  lines: z.array(EnvLineSchema),
});
export type EnvFile = z.infer<typeof EnvFileSchema>;

/** The env-browser write input (one or more line edits). */
export const EnvEditInputSchema = z.object({
  path: z.string().min(1).max(512),
  lineEdits: z
    .array(
      z.object({
        line: z.number().int().min(1).max(100_000),
        newRaw: z.string().min(0).max(8192),
      }),
    )
    .min(1)
    .max(500),
  /** The pre-write hash of the file, captured at token-issue time. */
  preWriteHash: zSha256,
});
export type EnvEditInput = z.infer<typeof EnvEditInputSchema>;
