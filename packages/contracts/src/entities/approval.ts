/**
 * Approvals + dashboard command audit entities.
 *
 * Approvals back the §3 flow: a request → typed phrase → token → action.
 * `DashboardCommandAudit` is the two-phase log that records
 * `created → running → finished` for every privileged command execution
 * (THREAT_MODEL §6.2 / SR-090).
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp, zSha256 } from '../primitives.js';
import { ApprovalClassSchema } from '../approval.js';

// ---------------------------------------------------------------------------
// Approval status
// ---------------------------------------------------------------------------

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
  'consumed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// ---------------------------------------------------------------------------
// ApprovalRequest (the queued request)
// ---------------------------------------------------------------------------

/**
 * The request that the UI shows in the "Pending" tab. Mirrors
 * `pending_approvals` in the DB.
 */
export const ApprovalRequestSchema = z.object({
  id: zUuidV4,
  actorId: zUuidV4,
  actorUsername: z.string().min(1).max(64),
  /** Surface that requires approval (THREAT_MODEL §1.2). */
  surface: z.string().min(1).max(64),
  /** The tool / action name (e.g. "systemd.restart"). */
  tool: z.string().min(1).max(128),
  /** Short human summary. */
  summary: z.string().min(1).max(500),
  /** JSON-serialized args preview. Server redacts secrets (THREAT_MODEL §5.3). */
  argsPreview: z.record(z.string(), z.unknown()),
  /** Hash of the action descriptor — token must match (SR-120). */
  actionHash: zSha256,
  class: ApprovalClassSchema,
  requestedAt: zIsoTimestamp,
  status: ApprovalStatusSchema.default('pending'),
  /** Resolver (admin who approved/denied). */
  decidedBy: zUuidV4.nullable().optional(),
  decidedAt: zIsoTimestamp.nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
  expiresAt: zIsoTimestamp,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** The decision input from `/api/approvals` POST. */
export const ApprovalDecisionInputSchema = z.object({
  id: zUuidV4,
  decision: z.enum(['approve', 'deny']),
  reason: z.string().max(1000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;

// ---------------------------------------------------------------------------
// DashboardCommandAudit (SR-090)
// ---------------------------------------------------------------------------

/**
 * The two-phase audit row for a privileged command. The `command` is the
 * fixed argv, never a free-form string. The `output` is the captured
 * stdout+stderr; secret redaction is the server's responsibility
 * (THREAT_MODEL §5.3).
 */
export const DashboardCommandStatusSchema = z.enum([
  'created',
  'running',
  'finished',
  'failed',
  'cancelled',
  'timed_out',
]);
export type DashboardCommandStatus = z.infer<typeof DashboardCommandStatusSchema>;

export const DashboardCommandAuditSchema = z.object({
  id: zUuidV4,
  requestId: zUuidV4,
  requestedBy: zUuidV4,
  /** Tool/surface name, e.g. "systemd.restart", "docker.action". */
  command: z.string().min(1).max(128),
  /** Fixed argv (never a free-form string). */
  argv: z.array(z.string().min(1).max(512)),
  status: DashboardCommandStatusSchema,
  output: z.string().max(64_000).default(''),
  stderr: z.string().max(64_000).default(''),
  exitCode: z.number().int().min(-1).max(255).nullable().optional(),
  /** Approval token hash that authorized the command (never the token). */
  approvalHash: zSha256.nullable().optional(),
  createdAt: zIsoTimestamp,
  updatedAt: zIsoTimestamp,
  finishedAt: zIsoTimestamp.nullable().optional(),
});
export type DashboardCommandAudit = z.infer<typeof DashboardCommandAuditSchema>;

/** Input to create a new command audit row (when the action is dispatched). */
export const DashboardCommandCreateSchema = z.object({
  requestId: zUuidV4,
  command: z.string().min(1).max(128),
  argv: z.array(z.string().min(1).max(512)).min(1).max(64),
  approvalHash: zSha256.optional(),
});
export type DashboardCommandCreate = z.infer<typeof DashboardCommandCreateSchema>;

/** Input to update the row when the action finishes. */
export const DashboardCommandFinishSchema = z.object({
  id: zUuidV4,
  status: z.enum(['finished', 'failed', 'cancelled', 'timed_out']),
  output: z.string().max(64_000).optional(),
  stderr: z.string().max(64_000).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
});
export type DashboardCommandFinish = z.infer<typeof DashboardCommandFinishSchema>;
