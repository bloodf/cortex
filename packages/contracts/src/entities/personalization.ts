/**
 * Dashboard personalization entities: AppPreference, DashboardLayout,
 * WidgetConfig. Backed by the `config` and `dashboard_layouts` tables;
 * the wire shape is what the SvelteKit `+page.server.ts` loaders return.
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// App preference (theme, accent, locale, etc.)
// ---------------------------------------------------------------------------

/** The set of preference keys the dashboard knows about. */
export const AppPreferenceKeySchema = z.enum([
  'theme.mode', // 'light' | 'dark' | 'system'
  'theme.accent', // 'cortex' | 'teal' | 'emerald' | 'amber'
  'i18n.locale', // 'en' | 'es' | 'pt-br'
  'overview.refreshMs', // number
  'terminal.fontFamily', // string
  'terminal.fontSize', // number
  'favorites', // string[] of service slugs
  'sidebar.collapsed', // boolean
]);
export type AppPreferenceKey = z.infer<typeof AppPreferenceKeySchema>;

/** A user-or-global preference. The value is JSON-serializable. */
export const AppPreferenceSchema = z.object({
  key: AppPreferenceKeySchema,
  /** JSON-serializable value. */
  value: z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.array(z.string().max(256)).max(1000),
    z.null(),
  ]),
  userId: zUuidV4.nullable(),
  updatedAt: zIsoTimestamp,
});
export type AppPreference = z.infer<typeof AppPreferenceSchema>;

// ---------------------------------------------------------------------------
// Dashboard layout (overview widgets)
// ---------------------------------------------------------------------------

/** Position + size of a single widget. */
export const WidgetPositionSchema = z.object({
  x: z.number().int().min(0).max(64),
  y: z.number().int().min(0).max(1024),
  w: z.number().int().min(1).max(64),
  h: z.number().int().min(1).max(64),
  /** Optional minimum constraints (set by the widget spec). */
  minW: z.number().int().min(1).max(64).optional(),
  minH: z.number().int().min(1).max(64).optional(),
});
export type WidgetPosition = z.infer<typeof WidgetPositionSchema>;

/** Per-widget configuration. */
export const WidgetConfigSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  position: WidgetPositionSchema,
  /** Free-form per-widget settings. */
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type WidgetConfig = z.infer<typeof WidgetConfigSchema>;

export const DashboardLayoutSchema = z.object({
  id: zUuidV4,
  userId: zUuidV4.nullable(),
  /** The set of widgets on the overview page. */
  widgets: z.array(WidgetConfigSchema).max(64),
  /** Layout version (bump when the widget catalog changes). */
  version: z.number().int().min(1).default(1),
  updatedAt: zIsoTimestamp,
});
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

// ---------------------------------------------------------------------------
// LogEntry (log viewer; admin-only per SR-082)
// ---------------------------------------------------------------------------

export const LogEntrySchema = z.object({
  id: zUuidV4,
  ts: zIsoTimestamp,
  /** The producing service / source. */
  source: z.string().min(1).max(64),
  /** Free-form level. */
  level: z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']),
  message: z.string().min(0).max(8192),
  /** Free-form structured fields. */
  fields: z.record(z.string(), z.unknown()).default({}),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

// ---------------------------------------------------------------------------
// AI (assistant) entities — used by the chat panel + tool registry
// ---------------------------------------------------------------------------

/** The AI policy class — drives approval, rate limits, and audit. */
export const AIPolicyClassSchema = z.enum(['free', 'privileged', 'destructive', 'forbidden']);
export type AIPolicyClass = z.infer<typeof AIPolicyClassSchema>;

/** A single AI tool definition. Loaded from `policy.json` (SR-103). */
export const AIToolDefinitionSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(2000),
  policyClass: AIPolicyClassSchema,
  /** Per-user rate limit (per minute). */
  rateLimitPerMin: z.number().int().min(0).max(1000).default(60),
  /** Cooldown between calls (seconds). */
  cooldownSec: z.number().int().min(0).max(3600).default(0),
  /** JSON Schema describing the tool's args. */
  argsSchema: z.record(z.string(), z.unknown()),
  /** Free-form metadata. */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type AIToolDefinition = z.infer<typeof AIToolDefinitionSchema>;

/** The AI chat request from the client. */
export const AIRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().min(0).max(64_000),
        /** For `tool` role: which tool produced this content. */
        toolName: z.string().min(1).max(128).optional(),
        /** For `tool` role: the tool's call id (correlates request/result). */
        toolCallId: z.string().min(1).max(128).optional(),
      }),
    )
    .min(1)
    .max(128),
  model: z.string().min(1).max(128).optional(),
  /** Idempotency key (the request is a pure function of messages + model). */
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type AIRequest = z.infer<typeof AIRequestSchema>;

/** A single streaming chunk (SSE frame). */
export const AIResponseChunkSchema = z.object({
  type: z.enum(['text', 'tool_call', 'tool_result', 'error', 'done']),
  text: z.string().optional(),
  toolCall: z
    .object({
      id: z.string().min(1).max(128),
      name: z.string().min(1).max(128),
      args: z.record(z.string(), z.unknown()),
    })
    .optional(),
  toolResult: z
    .object({
      id: z.string().min(1).max(128),
      output: z.string().min(0).max(64_000),
      isError: z.boolean().default(false),
    })
    .optional(),
  error: z.string().optional(),
});
export type AIResponseChunk = z.infer<typeof AIResponseChunkSchema>;

/** The full AI response (one-shot, not streamed). */
export const AIResponseSchema = z.object({
  id: zUuidV4,
  model: z.string().min(1).max(128),
  text: z.string().min(0).max(64_000),
  toolCalls: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        args: z.record(z.string(), z.unknown()),
        /** Result, if the call was dispatched before the response was returned. */
        result: z
          .object({
            output: z.string().min(0).max(64_000),
            isError: z.boolean().default(false),
          })
          .optional(),
      }),
    )
    .default([]),
  /** Token usage; null when not provided by the upstream provider. */
  usage: z
    .object({
      promptTokens: z.number().int().min(0).max(1_000_000).nullable(),
      completionTokens: z.number().int().min(0).max(1_000_000).nullable(),
      totalTokens: z.number().int().min(0).max(1_000_000).nullable(),
    })
    .nullable()
    .default(null),
  createdAt: zIsoTimestamp,
});
export type AIResponse = z.infer<typeof AIResponseSchema>;

// ---------------------------------------------------------------------------
// Mail Guardian entities
// ---------------------------------------------------------------------------

export const MailVerdictSchema = z.enum([
  'ham',
  'spam',
  'phish',
  'malicious',
  'suspicious',
  'review',
]);
export type MailVerdict = z.infer<typeof MailVerdictSchema>;

export const MailOwnerDecisionSchema = z.enum(['keep', 'spam', 'block_sender', 'allow_sender']);
export type MailOwnerDecision = z.infer<typeof MailOwnerDecisionSchema>;

export const MailReviewSchema = z.object({
  id: zUuidV4,
  accountSlug: z.string().min(1).max(64),
  messageUid: z.string().min(1).max(256),
  messageId: z.string().min(1).max(1024).nullable().optional(),
  modelVerdict: MailVerdictSchema,
  modelConfidence: z.number().min(0).max(1),
  ownerDecision: MailOwnerDecisionSchema.nullable().optional(),
  approver: zUuidV4.nullable().optional(),
  requestedAt: zIsoTimestamp,
  resolvedAt: zIsoTimestamp.nullable().optional(),
  processedAction: z.string().max(128).nullable().optional(),
  queuedDecision: MailOwnerDecisionSchema.nullable().optional(),
  queuedStatus: z.enum(['pending', 'processed', 'failed']).nullable().optional(),
  queuedError: z.string().max(1000).nullable().optional(),
});
export type MailReview = z.infer<typeof MailReviewSchema>;

export const MailDecisionInputSchema = z.object({
  id: zUuidV4,
  decision: MailOwnerDecisionSchema,
});
export type MailDecisionInput = z.infer<typeof MailDecisionInputSchema>;

// ---------------------------------------------------------------------------
// Hermes agent entities
// ---------------------------------------------------------------------------

export const AgentFileSchema = z.object({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(512),
  language: z.string().min(1).max(64).optional(),
});
export type AgentFile = z.infer<typeof AgentFileSchema>;

export const AgentSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  files: z.array(AgentFileSchema).default([]),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentFileContentSchema = z.object({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(512),
  language: z.string().min(1).max(64).optional(),
  content: z.string().min(0).max(2_000_000),
});
export type AgentFileContent = z.infer<typeof AgentFileContentSchema>;
