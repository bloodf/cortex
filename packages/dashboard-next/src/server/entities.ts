/**
 * Local entity type definitions used by the server-side skeleton.
 *
 * These mirror the entities the contracts package (M1-WS1 by Kleppmann) will
 * expose. We define them locally so this workstream compiles independently
 * while the contracts package is being built in parallel.
 *
 * When the contracts package lands, swap the imports:
 *   import type { User, Service } from '@cortexos/contracts';
 * The shapes here are the v0.2 contract — call out any drift in the PR.
 */

// ---------------------------------------------------------------------------
// Branded ID primitives — prevent ID confusion at the type level.
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;
export type ServiceId = Brand<string, "ServiceId">;
export type AlertId = Brand<string, "AlertId">;
export type AuditEventId = Brand<string, "AuditEventId">;
export type ApprovalTokenId = Brand<string, "ApprovalTokenId">;
export type DashboardCommandAuditId = Brand<string, "DashboardCommandAuditId">;

/** Smart constructors — validate at the boundary, trust internally. */
export const asUserId = (s: string): UserId => s as UserId;
export const asSessionId = (s: string): SessionId => s as SessionId;
export const asServiceId = (s: string): ServiceId => s as ServiceId;
export const asAlertId = (s: string): AlertId => s as AlertId;
export const asAuditEventId = (s: string): AuditEventId => s as AuditEventId;
export const asApprovalTokenId = (s: string): ApprovalTokenId => s as ApprovalTokenId;
export const asDashboardCommandAuditId = (s: string): DashboardCommandAuditId =>
  s as DashboardCommandAuditId;

// ---------------------------------------------------------------------------
// User + Session
// ---------------------------------------------------------------------------

/** Group memberships drive RBAC decisions (THREAT_MODEL §1.2 surface 2). */
export type GroupName = "cortexos-admin" | "cortexos-auditor" | "cortexos-users";

/** Object form of a group membership, used by the contracts User
 *  (and by `toContractsUser` in `contracts-bridge.ts`). The local
 *  auth store stores the string-union form, but App.Locals exposes
 *  the object form after the bridge — and `isAdmin` / `hasGroup`
 *  in the auth module handle both. */
export interface GroupMembershipEntry {
  readonly name: GroupName;
  readonly isAdmin: boolean;
  readonly description?: string;
}

export interface User {
  readonly id: UserId;
  readonly username: string;
  /** Snake-case legacy alias — kept for backward-compat with code that
   *  predates the contracts shape migration. Always equal to `isAdmin`. */
  readonly is_admin: boolean;
  /** Canonical camelCase form (matches @cortexos/contracts User).
   *  The runtime always populates it via `toUserEntity` / `rowToUser`. */
  readonly isAdmin: boolean;
  readonly isActive: boolean;
  /** Group memberships. May be a string union (legacy / local auth
   *  shape, used by older test fixtures) or an array of objects
   *  (contracts shape — the form flowing through App.Locals after
   *  the contracts bridge). The auth module's `isAdmin` and
   *  `hasGroup` helpers handle both. */
  readonly groupMemberships: readonly (GroupName | GroupMembershipEntry)[];
}

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly csrfToken: string;
  /** Unix epoch ms. */
  readonly expiresAt: number;
  /** Best-effort binding (THREAT_MODEL SR-001, T-001). */
  readonly ua: string | null;
  readonly ip: string | null;
  /** Unix epoch ms — when role was last re-validated (SR-011, SR-012). */
  readonly lastRoleCheckAt: number;
}

// ---------------------------------------------------------------------------
// Service registry (matches `Service` in `src/lib/sys-pilot/types.ts`)
// ---------------------------------------------------------------------------

export type ServiceStatus = "online" | "offline" | "unknown" | "checking";
export type ServiceKind = "app" | "service" | "docker" | "process" | "dashboard-launcher";
export type HealthType = "http" | "tcp" | "docker" | "systemd" | "process";

export interface Service {
  id: ServiceId;
  slug: string;
  name: string;
  description: string | null;
  healthUrl: string | null;
  healthType: HealthType;
  category: string;
  openUrl: string | null;
  status: ServiceStatus;
  kind: ServiceKind;
  envSource: string | null;
  isActive: boolean;
  hasWebui: boolean;
  showInHealthcheck: boolean;
  showInWebui: boolean;
  sortOrder: number;
  iconType?: "auto" | "lucide" | "image" | "mono" | string;
  iconColor?: string | null;
  iconImage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceHealthSnapshot {
  serviceId: ServiceId;
  status: ServiceStatus;
  latencyMs: number | null;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertEventStatus = "firing" | "resolved" | "silenced";

export interface AlertRule {
  id: AlertId;
  name: string;
  query: string;
  severity: AlertSeverity;
  channels: readonly string[];
  enabled: boolean;
}

export interface AlertEvent {
  id: AlertId;
  ruleId: AlertId;
  severity: AlertSeverity;
  status: AlertEventStatus;
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Audit (THREAT_MODEL §6)
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: AuditEventId;
  actorUserId: UserId | null;
  actorSessionId: SessionId | null;
  actorIp: string | null;
  actorUserAgent: string | null;
  surface: string;
  action: string;
  target: string | null;
  result: "success" | "failure" | "denied" | "error";
  errorCode: string | null;
  requestId: string;
  prevHash: string | null;
  payloadHash: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Dashboard command audit (two-phase lifecycle, THREAT_MODEL §6.1 + SR-090)
// ---------------------------------------------------------------------------

export type CommandStatus = "created" | "running" | "finished" | "failed" | "cancelled";

export interface DashboardCommandAudit {
  id: DashboardCommandAuditId;
  requestId: string;
  requestedBy: UserId;
  command: string;
  target: string | null;
  status: CommandStatus;
  output: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
}

// ---------------------------------------------------------------------------
// Approval token (THREAT_MODEL §3)
// ---------------------------------------------------------------------------

export interface ApprovalToken {
  /** Opaque token string (HMAC-SHA256, base64url). */
  token: string;
  /** Unix epoch ms. */
  expiresAt: number;
  /** Unix epoch ms. */
  issuedAt: number;
  /** Action hash this token is bound to (THREAT_MODEL §3.5). */
  actionHash: string;
  /** Session id the token is bound to (SR-020). */
  sessionId: SessionId;
  /** TTL used to mint this token (seconds). */
  ttlSec: number;
}

// ---------------------------------------------------------------------------
// Pending approval row (THREAT_MODEL §3.5 + migrations/001 pending_approvals)
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approve" | "deny" | "timeout";

export interface PendingApproval {
  readonly id: ApprovalTokenId;
  readonly runId: string;
  readonly signalName: string;
  readonly role: string | null;
  readonly issueId: string | null;
  readonly reason: string | null;
  /** ISO timestamp. */
  readonly requestedAt: string;
  /** ISO timestamp — `null` means no timeout. */
  readonly timeoutAt: string | null;
  /** ISO timestamp — `null` while still pending. */
  readonly resolvedAt: string | null;
  readonly decision: ApprovalDecision | null;
  /** Username of the approver (THREAT_MODEL §6 audit). */
  readonly approver: string | null;
}

// ---------------------------------------------------------------------------
// Page<T> — pagination shape (matches contracts/src/query.ts Page<T>)
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: readonly T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface PageInput {
  page: number;
  pageSize: number;
  sort?: string;
  dir?: "asc" | "desc";
  filter?: Record<string, string | number | boolean | undefined>;
}
