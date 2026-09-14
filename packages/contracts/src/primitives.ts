/**
 * Branded primitive types for CortexOS contracts.
 *
 * The branded-type pattern prevents ID confusion at compile time: a `UserId` and
 * a `ServiceId` are both strings at runtime, but the type system refuses to mix
 * them. Functions that take a `ServiceId` cannot accidentally accept a
 * `UserId` even though both are strings.
 *
 * All branded IDs are created via the `xxxId()` factory functions, which
 * validate the input shape. To get a typed value from a raw string, call the
 * factory. To inspect the underlying value, use the `.valueOf()`-like helpers
 * (or just `String(id)` since these are nominally typed).
 *
 * @module
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Brand helper
// ---------------------------------------------------------------------------

/**
 * Construct a branded type. The brand is a phantom property that exists only
 * in the type system; runtime values are the underlying primitive.
 */
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/**
 * Mint a branded ID from a raw string. Performs no validation; use the schema
 * validators in `schemas/` for that. Use this only when you have already
 * validated the input through a schema parse.
 */
const make = <B extends string>(value: string): Brand<string, B> => value as Brand<string, B>;

// ---------------------------------------------------------------------------
// ID validators — used by schemas to gate ID-shaped strings
// ---------------------------------------------------------------------------

/**
 * Generic ID regex. Letters, digits, underscore, hyphen. 1-128 chars.
 * Slugs for entities; UUID v4 for ephemeral IDs; ULID for sortable audit IDs.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * UUID v4 (with version+variant nibbles). Used for `AuditId`, `EventId`,
 * `RequestId`, etc. — anything that needs to be globally unique without a
 * central allocator.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ULID: 26 chars Crockford base32, time-sortable. Used for audit + events. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Slug: lowercase letters, digits, dashes. Matches the `services.slug` shape. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export const IdPattern = {
  generic: ID_RE,
  uuidV4: UUID_V4_RE,
  ulid: ULID_RE,
  slug: SLUG_RE,
} as const;

// ---------------------------------------------------------------------------
// Concrete branded types
// ---------------------------------------------------------------------------

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ServiceId = Brand<string, 'ServiceId'>;
export type ServiceSlug = Brand<string, 'ServiceSlug'>;
export type HealthSnapshotId = Brand<string, 'HealthSnapshotId'>;
export type AlertRuleId = Brand<string, 'AlertRuleId'>;
export type AlertEventId = Brand<string, 'AlertEventId'>;
export type AuditId = Brand<string, 'AuditId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type ApprovalToken = Brand<string, 'ApprovalToken'>;
export type DashboardCommandId = Brand<string, 'DashboardCommandId'>;
export type ContainerId = Brand<string, 'ContainerId'>;
export type ImageId = Brand<string, 'ImageId'>;
export type VolumeId = Brand<string, 'VolumeId'>;
export type NetworkId = Brand<string, 'NetworkId'>;
export type IncusInstanceName = Brand<string, 'IncusInstanceName'>;
export type IncusImageFingerprint = Brand<string, 'IncusImageFingerprint'>;
export type SystemdUnitName = Brand<string, 'SystemdUnitName'>;
export type TerminalSessionId = Brand<string, 'TerminalSessionId'>;
export type TerminalCommandId = Brand<string, 'TerminalCommandId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type ProjectSlug = Brand<string, 'ProjectSlug'>;
export type NotificationId = Brand<string, 'NotificationId'>;
export type BackupSnapshotId = Brand<string, 'BackupSnapshotId'>;
export type SchedulerJobName = Brand<string, 'SchedulerJobName'>;
export type AgentSlug = Brand<string, 'AgentSlug'>;
export type AgentFilePath = Brand<string, 'AgentFilePath'>;
export type MailReviewId = Brand<string, 'MailReviewId'>;
export type MailAccountSlug = Brand<string, 'MailAccountSlug'>;
export type BadgeSlug = Brand<string, 'BadgeSlug'>;
export type WidgetId = Brand<string, 'WidgetId'>;
export type LayoutId = Brand<string, 'LayoutId'>;
export type PrefKey = Brand<string, 'AppPreferenceKey'>;
export type LogEntryId = Brand<string, 'LogEntryId'>;
export type AIRequestId = Brand<string, 'AIRequestId'>;
export type AIResponseId = Brand<string, 'AIResponseId'>;
export type PolicyClassId = Brand<string, 'PolicyClassId'>;

// ---------------------------------------------------------------------------
// Time primitives
// ---------------------------------------------------------------------------

/**
 * ISO-8601 timestamp with timezone. Always UTC. Always second-precision or
 * finer. Parsed via `z.string().datetime()` in Zod; this is the type
 * representation only.
 */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

/**
 * Unix epoch milliseconds. Used for high-throughput, low-precision timing
 * (e.g. rate-limit windows). 13 digits max.
 */
export type EpochMs = Brand<number, 'EpochMs'>;

/**
 * Unix epoch microseconds. Used by the audit chain algorithm
 * (THREAT_MODEL §6.4.1: `R_{n-1}.ts_unix_micros`).
 */
export type EpochMicros = Brand<number, 'EpochMicros'>;

export const makeIsoTimestamp = (s: string): IsoTimestamp => s as IsoTimestamp;
export const makeEpochMs = (n: number): EpochMs => n as EpochMs;
export const makeEpochMicros = (n: number): EpochMicros => n as EpochMicros;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export const userId = (s: string): UserId => make<'UserId'>(s);
export const sessionId = (s: string): SessionId => make<'SessionId'>(s);
export const serviceId = (s: string): ServiceId => make<'ServiceId'>(s);
export const serviceSlug = (s: string): ServiceSlug => make<'ServiceSlug'>(s);
export const healthSnapshotId = (s: string): HealthSnapshotId => make<'HealthSnapshotId'>(s);
export const alertRuleId = (s: string): AlertRuleId => make<'AlertRuleId'>(s);
export const alertEventId = (s: string): AlertEventId => make<'AlertEventId'>(s);
export const auditId = (s: string): AuditId => make<'AuditId'>(s);
export const auditEventId = (s: string): AuditEventId => make<'AuditEventId'>(s);
export const requestId = (s: string): RequestId => make<'RequestId'>(s);
export const approvalId = (s: string): ApprovalId => make<'ApprovalId'>(s);
export const approvalToken = (s: string): ApprovalToken => make<'ApprovalToken'>(s);
export const dashboardCommandId = (s: string): DashboardCommandId => make<'DashboardCommandId'>(s);
export const containerId = (s: string): ContainerId => make<'ContainerId'>(s);
export const imageId = (s: string): ImageId => make<'ImageId'>(s);
export const volumeId = (s: string): VolumeId => make<'VolumeId'>(s);
export const networkId = (s: string): NetworkId => make<'NetworkId'>(s);
export const incusInstanceName = (s: string): IncusInstanceName => make<'IncusInstanceName'>(s);
export const incusImageFingerprint = (s: string): IncusImageFingerprint =>
  make<'IncusImageFingerprint'>(s);
export const systemdUnitName = (s: string): SystemdUnitName => make<'SystemdUnitName'>(s);
export const terminalSessionId = (s: string): TerminalSessionId => make<'TerminalSessionId'>(s);
export const terminalCommandId = (s: string): TerminalCommandId => make<'TerminalCommandId'>(s);
export const projectId = (s: string): ProjectId => make<'ProjectId'>(s);
export const projectSlug = (s: string): ProjectSlug => make<'ProjectSlug'>(s);
export const notificationId = (s: string): NotificationId => make<'NotificationId'>(s);
export const backupSnapshotId = (s: string): BackupSnapshotId => make<'BackupSnapshotId'>(s);
export const schedulerJobName = (s: string): SchedulerJobName => make<'SchedulerJobName'>(s);
export const agentSlug = (s: string): AgentSlug => make<'AgentSlug'>(s);
export const agentFilePath = (s: string): AgentFilePath => make<'AgentFilePath'>(s);
export const mailReviewId = (s: string): MailReviewId => make<'MailReviewId'>(s);
export const mailAccountSlug = (s: string): MailAccountSlug => make<'MailAccountSlug'>(s);
export const badgeSlug = (s: string): BadgeSlug => make<'BadgeSlug'>(s);
export const widgetId = (s: string): WidgetId => make<'WidgetId'>(s);
export const layoutId = (s: string): LayoutId => make<'LayoutId'>(s);
export const appPreferenceKey = (s: string): PrefKey => make<'AppPreferenceKey'>(s);
export const logEntryId = (s: string): LogEntryId => make<'LogEntryId'>(s);
export const aiRequestId = (s: string): AIRequestId => make<'AIRequestId'>(s);
export const aiResponseId = (s: string): AIResponseId => make<'AIResponseId'>(s);
export const policyClassId = (s: string): PolicyClassId => make<'PolicyClassId'>(s);

// ---------------------------------------------------------------------------
// Zod primitive schemas (re-exported by schemas/index.ts)
// ---------------------------------------------------------------------------

/** Reusable Zod schema for any ID that follows the generic shape. */
export const zId = z.string().min(1).max(128).regex(ID_RE, 'id must match [A-Za-z0-9_-]{1,128}');

/** Reusable Zod schema for a UUID v4 string. */
export const zUuidV4 = z.string().regex(UUID_V4_RE, 'must be a UUID v4');

/** Reusable Zod schema for a ULID string. */
export const zUlid = z.string().regex(ULID_RE, 'must be a 26-char ULID');

/** Reusable Zod schema for a service-style slug. */
export const zSlug = z
  .string()
  .min(2)
  .max(64)
  .regex(SLUG_RE, 'slug must match [a-z0-9][a-z0-9-]{0,62}[a-z0-9]');

/** ISO-8601 datetime with timezone. Zod v3: `z.string().datetime({ offset: true })`. */
export const zIsoTimestamp = z.string().datetime({ offset: true });

/** Unix epoch milliseconds. */
export const zEpochMs = z.number().int().min(0).max(8_640_000_000_000); // through year 2243

/** Unix epoch microseconds. */
export const zEpochMicros = z.number().int().min(0).max(8_640_000_000_000_000);

/** IPv4 or IPv6 string. */
export const zIpAddress = z.union([
  z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/),
  z
    .string()
    .regex(/^[0-9a-fA-F:]+$/)
    .min(2)
    .max(45),
]);

/** User-Agent header. Free-form; cap at 1024 chars to bound the audit row. */
export const zUserAgent = z.string().min(0).max(1024);

/**
 * Hex-encoded SHA-256 digest (lowercase, 64 chars). Also used for
 * HMAC-SHA256 values, which share the exact same wire shape.
 */
export const zSha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-char hex SHA-256 digest');
