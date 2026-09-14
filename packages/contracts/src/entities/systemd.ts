/**
 * Systemd entities: Unit, action envelope.
 *
 * Per THREAT_MODEL §4.4.2 + SR-030: the action set is closed, the unit
 * name is regex-validated AND allowlisted, and critical units require
 * the approval flow (SR-120).
 *
 * @module
 */
import { z } from 'zod';
import { zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// Unit state
// ---------------------------------------------------------------------------

/** The "active" field of `systemctl show`. */
export const SystemdActiveStateSchema = z.enum([
  'active',
  'inactive',
  'failed',
  'activating',
  'deactivating',
  'reloading',
  'maintenance',
  'unknown',
]);
export type SystemdActiveState = z.infer<typeof SystemdActiveStateSchema>;

/** The "load" field. */
export const SystemdLoadStateSchema = z.enum([
  'loaded',
  'not-found',
  'bad-setting',
  'error',
  'merged',
  'masked',
  'stub',
  'unknown',
]);
export type SystemdLoadState = z.infer<typeof SystemdLoadStateSchema>;

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

/**
 * A single systemd unit (service, timer, mount, etc.). The dashboard
 * surfaces services; the schema is generic.
 */
export const SystemdUnitSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(500).default(''),
  load: SystemdLoadStateSchema,
  active: SystemdActiveStateSchema,
  sub: z.string().min(0).max(128).default(''),
  /** Derived: active === 'active' AND sub === 'running'. */
  enabled: z.boolean().default(false),
  /** The unit type, e.g. "service", "timer", "mount". */
  type: z.string().min(1).max(32).default('service'),
  /** Path of the unit file (when load=loaded). */
  unitPath: z.string().max(512).nullable().optional(),
  /** Whether this unit is allowlisted in `policy.json` (SR-030). */
  allowlisted: z.boolean().default(false),
  /** Whether this is a "critical" unit that requires approval (SR-120). */
  critical: z.boolean().default(false),
});
export type SystemdUnit = z.infer<typeof SystemdUnitSchema>;

// ---------------------------------------------------------------------------
// Action envelope (admin-only)
// ---------------------------------------------------------------------------

/** The closed set of admin actions the dashboard may perform on a unit. */
export const SystemdActionKindSchema = z.enum([
  'start',
  'stop',
  'restart',
  'reload',
  'status',
  'enable',
  'disable',
  'list-units',
]);
export type SystemdActionKind = z.infer<typeof SystemdActionKindSchema>;

export const SystemdActionInputSchema = z.object({
  action: SystemdActionKindSchema,
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.@-]+$/),
});
export type SystemdActionInput = z.infer<typeof SystemdActionInputSchema>;

export const SystemdActionResultSchema = z.object({
  stdout: z.string().max(64_000).default(''),
  stderr: z.string().max(64_000).default(''),
  exitCode: z.number().int().min(-1).max(255).optional(),
});
export type SystemdActionResult = z.infer<typeof SystemdActionResultSchema>;

// ---------------------------------------------------------------------------
// Log line (used by the log viewer; 1-line of journalctl output)
// ---------------------------------------------------------------------------

export const SystemdLogLineSchema = z.object({
  ts: zIsoTimestamp,
  priority: z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']),
  unit: z.string().min(1).max(128),
  message: z.string().min(0).max(8192),
});
export type SystemdLogLine = z.infer<typeof SystemdLogLineSchema>;
