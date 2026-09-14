/**
 * Re-exports of every Zod schema in the package, prefixed `Schema`
 * (vs. the type-only exports from `entities/`).
 *
 * The entity files already export their schemas under their bare names
 * (e.g. `ServiceSchema`). This barrel exists for two reasons:
 *
 *   1. The M0-F test strategy says SvelteKit mock handlers and server
 *      `+server.ts` routes should import from `src/lib/contracts/schemas`.
 *      This module gives that path a single, stable home.
 *   2. The JSON-schema build script iterates over this barrel to emit
 *      one `*.json` per schema into `dist/schemas/`.
 *
 * @module
 */

// Foundational schemas.
export {
  PageInputSchema,
  PageSchema,
  SortSpecSchema,
  FilterSchema,
  FilterClauseSchema,
  SortDirSchema,
} from '../query.js';

export {
  CortexErrorSchema,
  ErrorCodeSchema,
  ValidationErrorSchema,
  AuthRequiredErrorSchema,
  AuthInvalidErrorSchema,
  PermissionDeniedErrorSchema,
  NotFoundErrorSchema,
  ConflictErrorSchema,
  RateLimitErrorSchema,
  ApprovalRequiredErrorSchema,
  ApprovalExpiredErrorSchema,
  ApprovalReplayErrorSchema,
  DependencyFailedErrorSchema,
  SystemErrorSchema,
  ZodIssueSchema,
  FieldErrorsSchema,
} from '../errors.js';

export {
  AuditEventSchema,
  AuditEntrySchema,
  AuditSurfaceSchema,
  AuditResultSchema,
  AuditDecisionSchema,
  AuditSeveritySchema,
} from '../audit.js';

export {
  ApprovalRequestPayloadSchema,
  ApprovalResponseSchema,
  ApprovalClaimsSchema,
  ApprovalTokenSchema,
  ApprovalClassSchema,
} from '../approval.js';

// Every entity schema.
export {
  // User
  GroupMembershipSchema,
  UserSchema,
  UserInputSchema,
  SessionSchema,
  CurrentSessionSchema,
  LoginInputSchema,
  LoginResponseSchema,
  // Service
  ServiceSchema,
  ServiceInputSchema,
  ServiceUpdateSchema,
  ServiceCheckSchema,
  ServiceHealthSnapshotSchema,
  UptimeStatSchema,
  UptimeIncidentSchema,
  BadgeSchema,
  BadgeInputSchema,
  BadgeRefSchema,
  // System
  SystemDataSchema,
  MemorySchema,
  DriveInfoSchema,
  MountInfoSchema,
  MachineSensorSchema,
  NetworkDataSchema,
  NetworkInterfaceSchema,
  ProcessInfoSchema,
  // Docker
  DockerContainerSchema,
  DockerImageSchema,
  DockerVolumeSchema,
  DockerNetworkSchema,
  DockerActionInputSchema,
  DockerActionResultSchema,
  // Incus
  IncusInstanceSchema,
  IncusLiveInstanceSchema,
  IncusImageSchema,
  IncusInstanceConfigSchema,
  ProgressStepSchema,
  ProgressReportSchema,
  IncusPreflightCheckSchema,
  IncusPreflightReportSchema,
  IncusShellInputSchema,
  IncusShellResultSchema,
  IncusActionInputSchema,
  IncusActionResultSchema,
  ProvisioningRequestSchema,
  ProvisioningResultSchema,
  // Systemd
  SystemdUnitSchema,
  SystemdActionInputSchema,
  SystemdActionResultSchema,
  SystemdLogLineSchema,
  // Alert
  AlertRuleSchema,
  AlertRuleInputSchema,
  AlertRuleUpdateSchema,
  AlertEventSchema,
  OperationalAlertSchema,
  // Approval + command audit
  ApprovalRequestSchema,
  ApprovalDecisionInputSchema,
  DashboardCommandAuditSchema,
  DashboardCommandCreateSchema,
  DashboardCommandFinishSchema,
  // Terminal
  TerminalSessionSchema,
  TerminalActionSchema,
  TerminalCommandSchema,
  EnvLineSchema,
  EnvFileSchema,
  EnvEditInputSchema,
  // Misc
  ProjectSchema,
  ProjectInputSchema,
  ProjectUpdateSchema,
  NotificationEntrySchema,
  BackupSnapshotSchema,
  ScheduledJobSchema,
  // Personalization + AI
  AppPreferenceSchema,
  DashboardLayoutSchema,
  WidgetConfigSchema,
  WidgetPositionSchema,
  LogEntrySchema,
  AIToolDefinitionSchema,
  AIRequestSchema,
  AIResponseSchema,
  AIResponseChunkSchema,
  MailReviewSchema,
  MailDecisionInputSchema,
  AgentSchema,
  AgentFileSchema,
  AgentFileContentSchema,
} from '../entities/index.js';
