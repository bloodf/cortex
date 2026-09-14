/**
 * Project, Notification, BackupSnapshot, SchedulerJob — the
 * "miscellaneous catalog" entities used by the admin pages and the
 * `/backups`, `/scheduler`, `/projects` pages.
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp, zSlug } from '../primitives.js';

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** How project-level messaging is routed. */
export const MessagingModeSchema = z.enum(['single', 'distributed']);
export type MessagingMode = z.infer<typeof MessagingModeSchema>;

export const ProjectSchema = z.object({
  id: zUuidV4,
  slug: zSlug,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).nullable().optional(),
  repoUrl: z.string().url().nullable().optional(),
  branch: z.string().min(1).max(128).default('main'),
  messagingMode: MessagingModeSchema.default('single'),
  createdAt: zIsoTimestamp,
  updatedAt: zIsoTimestamp,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectInputSchema = z.object({
  slug: zSlug,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  repoUrl: z.string().url().optional(),
  branch: z.string().min(1).max(128).default('main'),
  messagingMode: MessagingModeSchema.default('single'),
});
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export const ProjectUpdateSchema = z.object({
  slug: zSlug,
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
  repoUrl: z.string().url().optional(),
  branch: z.string().min(1).max(128).optional(),
  messagingMode: MessagingModeSchema.optional(),
});
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/** The current implementation has no /api/notifications route. Reserved. */
export const NotificationEntrySchema = z.object({
  id: zUuidV4,
  channel: z.enum(['ui', 'email', 'webhook']),
  message: z.string().min(1).max(2000),
  sentAt: zIsoTimestamp,
  status: z.enum(['pending', 'delivered', 'failed']),
  /** Free-form metadata (e.g. webhook response code). */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type NotificationEntry = z.infer<typeof NotificationEntrySchema>;

// ---------------------------------------------------------------------------
// BackupSnapshot
// ---------------------------------------------------------------------------

export const BackupStatusSchema = z.enum(['ok', 'partial', 'failed', 'in_progress']);
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const BackupSnapshotSchema = z.object({
  id: zUuidV4,
  /** Display name (e.g. `cortexos-2026-06-03.tar.gz.age`). */
  name: z.string().min(1).max(256),
  createdAt: zIsoTimestamp,
  /** Bytes; null while the snapshot is still being assembled. */
  size: z.number().int().min(0).nullable().optional(),
  status: BackupStatusSchema,
  /** Where the snapshot lives (NAS mount, S3 path, etc.). */
  location: z.string().max(512),
  /** Free-form notes (e.g. "included .secrets/", "pre-upgrade snapshot"). */
  notes: z.string().max(1000).nullable().optional(),
});
export type BackupSnapshot = z.infer<typeof BackupSnapshotSchema>;

// ---------------------------------------------------------------------------
// SchedulerJob (systemd timer)
// ---------------------------------------------------------------------------

export const ScheduledJobSchema = z.object({
  /** The systemd timer unit name. */
  name: z.string().min(1).max(128),
  /** Human description. */
  description: z.string().max(500).default(''),
  /** Cron expression (OnCalendar). */
  schedule: z.string().min(1).max(128),
  /** When the timer will next fire. */
  nextRun: zIsoTimestamp.nullable().optional(),
  /** When the timer last fired. */
  lastRun: zIsoTimestamp.nullable().optional(),
  /** Result of the last run. */
  lastResult: z.enum(['ok', 'failed', 'timeout', 'unknown']).default('unknown'),
  enabled: z.boolean().default(true),
});
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;
