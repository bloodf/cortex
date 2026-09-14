/**
 * Service registry entities: Service, Badge, HealthSnapshot, UptimeStat.
 *
 * The service catalog is the single source of truth for the dashboard's
 * "what runs on this host" view (THREAT_MODEL §3.4.2: allowlisted in
 * `policy.json` for destructive actions; SR-030 for name allowlisting).
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp, zSlug } from '../primitives.js';

// ---------------------------------------------------------------------------
// Service kind (entity classification)
// ---------------------------------------------------------------------------

/**
 * How the service is implemented on the host. Drives both the health
 * probe and the allowed actions. Mirrors `services.kind` in the DB.
 */
export const ServiceKindSchema = z.enum([
  'app',
  'service',
  'docker',
  'process',
  'incus',
  'systemd',
]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

/** How the dashboard probes a service. See `health_url` in the DB. */
export const HealthTypeSchema = z.enum([
  'http',
  'tcp',
  'docker',
  'systemd',
  'process',
  'incus',
  'none',
]);
export type HealthType = z.infer<typeof HealthTypeSchema>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The live status of a service, set by the health probe. */
export const ServiceStatusSchema = z.enum(['online', 'offline', 'unknown', 'checking', 'degraded']);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export const BadgeSchema = z.object({
  slug: zSlug,
  label: z.string().min(1).max(64),
  /** Foreground (text) color, hex `#rrggbb` (UI color picker). */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  /** Background color, hex `#rrggbb`. */
  textColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  description: z.string().max(256).nullable().optional(),
  createdAt: zIsoTimestamp.optional(),
});
export type Badge = z.infer<typeof BadgeSchema>;

export const BadgeInputSchema = z.object({
  slug: zSlug,
  label: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  textColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type BadgeInput = z.infer<typeof BadgeInputSchema>;

/** Denormalized badge reference embedded on a Service. */
export const BadgeRefSchema = z.object({
  slug: zSlug,
  label: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});
export type BadgeRef = z.infer<typeof BadgeRefSchema>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The icon source for a service card. */
export const ServiceIconSchema = z.object({
  type: z.enum(['auto', 'monogram', 'image']),
  /** Hex color `#rrggbb` for monogram tint (when type=monogram). */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  /** Data URI or `/uploads/...` path. */
  image: z.string().min(1).max(2048).nullable().optional(),
});
export type ServiceIcon = z.infer<typeof ServiceIconSchema>;

export const ServiceSchema = z.object({
  id: zUuidV4,
  slug: zSlug,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).nullable().optional(),
  kind: ServiceKindSchema,
  category: z.string().min(1).max(64),
  /** Health endpoint URL; required iff `healthType !== 'none'`. */
  healthUrl: z.string().min(1).max(512),
  healthType: HealthTypeSchema,
  /** Public link for the user (set by `cortex_set_service_urls`). */
  openUrl: z.string().min(1).max(512).nullable().optional(),
  /** Path to the env file backing this service (for env-browser reveal). */
  envSource: z.string().max(512).nullable().optional(),
  status: ServiceStatusSchema.default('unknown'),
  lastCheckAt: zIsoTimestamp.nullable().optional(),
  responseMs: z.number().int().min(0).max(600_000).nullable().optional(),
  /** 24h uptime percent (0-100). */
  uptime24h: z.number().min(0).max(100).nullable().optional(),
  icon: ServiceIconSchema.optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  isActive: z.boolean().default(true),
  hasWebui: z.boolean().default(false),
  showInHealthcheck: z.boolean().default(true),
  showInWebui: z.boolean().default(true),
  badges: z.array(BadgeRefSchema).default([]),
  createdAt: zIsoTimestamp,
  updatedAt: zIsoTimestamp,
});
export type Service = z.infer<typeof ServiceSchema>;

/** Create input for a new service. */
export const ServiceInputSchema = z.object({
  slug: zSlug,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  kind: ServiceKindSchema.default('service'),
  category: z.string().min(1).max(64),
  healthUrl: z.string().min(1).max(512),
  healthType: HealthTypeSchema.default('http'),
  openUrl: z.string().min(1).max(512).optional(),
  envSource: z.string().max(512).optional(),
  icon: ServiceIconSchema.optional(),
  badges: z.array(zSlug).max(16).default([]),
});
export type ServiceInput = z.infer<typeof ServiceInputSchema>;

/** Update input — every field optional except the id. */
export const ServiceUpdateSchema = z.object({
  id: zUuidV4,
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().min(1).max(64).optional(),
  healthUrl: z.string().min(1).max(512).optional(),
  healthType: HealthTypeSchema.optional(),
  openUrl: z.string().min(1).max(512).optional(),
  envSource: z.string().max(512).optional(),
  isActive: z.boolean().optional(),
  hasWebui: z.boolean().optional(),
  showInHealthcheck: z.boolean().optional(),
  showInWebui: z.boolean().optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  badges: z.array(zSlug).max(16).optional(),
});
export type ServiceUpdate = z.infer<typeof ServiceUpdateSchema>;

// ---------------------------------------------------------------------------
// Live probe (returned by `/api/services?raw=1`)
// ---------------------------------------------------------------------------

/** A service snapshot returned by the live health probe. */
export const ServiceCheckSchema = ServiceSchema.extend({
  /** Same fields; the probe may set `lastCheckAt`, `responseMs`, `uptime24h`. */
});
export type ServiceCheck = z.infer<typeof ServiceCheckSchema>;

// ---------------------------------------------------------------------------
// Health snapshot
// ---------------------------------------------------------------------------

/** A point-in-time record of a service's probe result. */
export const ServiceHealthSnapshotSchema = z.object({
  id: zUuidV4,
  serviceId: zUuidV4,
  status: ServiceStatusSchema,
  /** Probe latency in milliseconds. */
  latencyMs: z.number().int().min(0).max(600_000).nullable(),
  checkedAt: zIsoTimestamp,
  /** Free-form note (e.g. "HTTP 503", "tcp connect refused"). */
  note: z.string().max(1000).nullable().optional(),
});
export type ServiceHealthSnapshot = z.infer<typeof ServiceHealthSnapshotSchema>;

// ---------------------------------------------------------------------------
// Uptime statistics
// ---------------------------------------------------------------------------

/** The window over which uptime is computed. */
export const UptimeWindowSchema = z.enum(['1h', '24h', '7d', '30d']);
export type UptimeWindow = z.infer<typeof UptimeWindowSchema>;

/** Aggregated uptime stat for a service. */
export const UptimeStatSchema = z.object({
  serviceId: zUuidV4,
  serviceSlug: zSlug,
  window: UptimeWindowSchema,
  /** 0..100; null if there were no probes in the window. */
  uptimePercent: z.number().min(0).max(100).nullable(),
  /** Number of state transitions (online↔offline) in the window. */
  incidents: z.number().int().min(0),
  totalChecks: z.number().int().min(0),
  failedChecks: z.number().int().min(0),
  /** ISO start of the window. */
  windowStart: zIsoTimestamp,
  windowEnd: zIsoTimestamp,
});
export type UptimeStat = z.infer<typeof UptimeStatSchema>;

// ---------------------------------------------------------------------------
// Uptime incident (returned alongside UptimeStat for the timeline view)
// ---------------------------------------------------------------------------

export const UptimeIncidentSchema = z.object({
  serviceId: zUuidV4,
  serviceSlug: zSlug,
  /** When the service transitioned to `offline` (or `degraded`). */
  startedAt: zIsoTimestamp,
  resolvedAt: zIsoTimestamp.nullable(),
  durationSec: z.number().int().min(0).nullable(),
  /** What the service was doing when it failed. */
  cause: z.string().max(256).nullable().optional(),
});
export type UptimeIncident = z.infer<typeof UptimeIncidentSchema>;
