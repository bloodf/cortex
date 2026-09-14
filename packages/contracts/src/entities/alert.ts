/**
 * Alert entities: AlertRule, AlertEvent, operational alert.
 *
 * The dashboard supports two distinct alert concerns, both in
 * `lib/db/alerts.ts`: rule-based alerts (`alert_rules` + `alert_history`)
 * and operational alerts (`alerts`). The schema reflects both.
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

// ---------------------------------------------------------------------------
// Rule condition
// ---------------------------------------------------------------------------

/**
 * The condition a rule evaluates against. Mirrors `alert_rules.condition`
 * in the DB. `response_time` requires `thresholdMs`.
 */
export const AlertConditionSchema = z.enum(['offline', 'online', 'response_time']);
export type AlertCondition = z.infer<typeof AlertConditionSchema>;

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

/** The set of delivery channels. */
export const AlertChannelSchema = z.enum([
  'ui', // In-app toast (IncidentToaster)
  'email', // SMTP — admin-configured
  'webhook', // Generic webhook (Slack/Discord-compatible)
  'log', // Append to a log only
]);
export type AlertChannel = z.infer<typeof AlertChannelSchema>;

// ---------------------------------------------------------------------------
// AlertRule
// ---------------------------------------------------------------------------

export const AlertRuleSchema = z.object({
  id: zUuidV4,
  name: z.string().min(1).max(128),
  serviceId: zUuidV4.nullable(),
  /** What triggers the rule. */
  condition: AlertConditionSchema,
  /** Threshold in ms; required when `condition=response_time`. */
  thresholdMs: z.number().int().min(1).max(600_000).nullable().optional(),
  severity: AlertSeveritySchema.default('warning'),
  channels: z.array(AlertChannelSchema).min(1).default(['ui']),
  enabled: z.boolean().default(true),
  createdAt: zIsoTimestamp,
  updatedAt: zIsoTimestamp,
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

/** Create input. */
export const AlertRuleInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    serviceId: zUuidV4.nullable().optional(),
    condition: AlertConditionSchema,
    thresholdMs: z.number().int().min(1).max(600_000).optional(),
    severity: AlertSeveritySchema.default('warning'),
    channels: z.array(AlertChannelSchema).min(1).default(['ui']),
    enabled: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.condition === 'response_time' ? v.thresholdMs !== undefined : v.thresholdMs === undefined,
    {
      message: 'thresholdMs is required when condition=response_time, and forbidden otherwise',
    },
  );
export type AlertRuleInput = z.infer<typeof AlertRuleInputSchema>;

/** Update input — every field optional except id. */
export const AlertRuleUpdateSchema = z.object({
  id: zUuidV4,
  name: z.string().min(1).max(128).optional(),
  serviceId: zUuidV4.nullable().optional(),
  condition: AlertConditionSchema.optional(),
  thresholdMs: z.number().int().min(1).max(600_000).nullable().optional(),
  severity: AlertSeveritySchema.optional(),
  channels: z.array(AlertChannelSchema).min(1).optional(),
  enabled: z.boolean().optional(),
});
export type AlertRuleUpdate = z.infer<typeof AlertRuleUpdateSchema>;

// ---------------------------------------------------------------------------
// AlertEvent (history row — once a rule fires)
// ---------------------------------------------------------------------------

export const AlertEventStatusSchema = z.enum(['fired', 'resolved', 'info']);
export type AlertEventStatus = z.infer<typeof AlertEventStatusSchema>;

export const AlertEventSchema = z.object({
  id: zUuidV4,
  ruleId: zUuidV4.nullable(),
  ruleName: z.string().max(128).nullable().optional(),
  serviceId: zUuidV4.nullable(),
  serviceName: z.string().max(128).nullable().optional(),
  status: AlertEventStatusSchema,
  severity: AlertSeveritySchema,
  message: z.string().min(1).max(2000),
  firedAt: zIsoTimestamp,
  resolvedAt: zIsoTimestamp.nullable().optional(),
  /** Duration in seconds; null if not resolved. */
  durationSec: z.number().int().min(0).nullable().optional(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

// ---------------------------------------------------------------------------
// Operational alert (the in-app "alerts" feed from the socket)
// ---------------------------------------------------------------------------

export const OperationalAlertSchema = z.object({
  id: zUuidV4,
  severity: AlertSeveritySchema,
  title: z.string().min(1).max(256),
  message: z.string().min(1).max(2000),
  source: z.string().min(1).max(64),
  createdAt: zIsoTimestamp,
  /** Whether the alert has been acknowledged. */
  acknowledged: z.boolean().default(false),
  acknowledgedBy: zUuidV4.nullable().optional(),
  acknowledgedAt: zIsoTimestamp.nullable().optional(),
});
export type OperationalAlert = z.infer<typeof OperationalAlertSchema>;
