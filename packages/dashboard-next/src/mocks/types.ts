export type ServiceStatus = "online" | "offline" | "unknown";
export type CheckStatus = ServiceStatus | "checking";

export interface ServiceCheck {
  id: number;
  slug: string;
  name: string;
  open_url: string;
  category: string;
  status: ServiceStatus;
  responseTime: number;
  icon_color: string | null;
  icon_image: string | null;
}

export interface BadgeRef {
  slug: string;
  label: string;
  color: string;
}

export interface Service extends ServiceCheck {
  kind: "app" | "service" | "docker" | "process" | "dashboard-launcher";
  health_url: string;
  health_type: "http" | "tcp" | "docker" | "systemd" | "process";
  description: string | null;
  env_source: string | null;
  is_active: boolean;
  has_webui: boolean;
  show_in_healthcheck: boolean;
  show_in_webui: boolean;
  sort_order: number;
  icon_type: string;
  badges: BadgeRef[];
}

export interface MachineSensor {
  id: string;
  label: string;
  value: number;
  unit: "celsius" | "rpm" | "volts";
  source: string;
}

export interface DriveInfo {
  name: string;
  model: string;
  size: number;
  type?: string;
  mount?: string;
  used?: number;
  total?: number;
  percent?: number;
}

export interface MountInfo {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  free: number;
  percent: number;
}

export interface SystemData {
  cpu: number;
  memory: { percent: number; used: number; total: number };
  drives: DriveInfo[];
  mounts: MountInfo[];
  load: number[];
  uptime: number;
  sensors: {
    cpuTemperature: MachineSensor | null;
    temperatures: MachineSensor[];
    fans: MachineSensor[];
    voltages: MachineSensor[];
  };
}

export interface ProcessInfo {
  pid: number;
  user: string;
  command: string;
  cpu: number;
  mem: number;
}

export interface NetworkInterface {
  name: string;
  rxKbps: number;
  txKbps: number;
  rxBytesTotal: number;
  txBytesTotal: number;
}
export interface NetworkData {
  interfaces: NetworkInterface[];
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "restarting";
  ports: string;
  created: string;
}
export interface DockerImage {
  id: string;
  repo: string;
  tag: string;
  size: number | null;
  created: string;
}
export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  size: number | null;
}

export interface IncusInstance {
  name: string;
  slug: string;
  status: "draft" | "validated" | "provisioning" | "active" | "failed";
  type: "container" | "vm";
  image: string;
  cpu: number | null;
  memory: number | null;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  last_validation: { ok: boolean; ran_at: string; notes: string } | null;
  created_at: string;
  /** Project hosted by this instance — every Incus instance is one project. */
  project: {
    name: string;
    description: string;
    repo_url: string;
    branch: string;
  };
}

export interface SystemdUnit {
  name: string;
  description: string;
  load: string;
  active: "active" | "inactive" | "failed";
  sub: string;
  enabled: boolean;
  allowlisted: boolean;
  critical: boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  service_id: number;
  condition: "offline" | "online" | "response_time";
  threshold_ms: number | null;
  enabled: boolean;
}
export interface AlertHistory {
  id: string;
  ruleName: string;
  serviceName: string;
  status: "fired" | "resolved" | "info";
  message: string;
  timestamp: string;
}

export interface ApprovalRequest {
  id: string;
  actor: string;
  tool: string;
  summary: string;
  args_preview: string;
  requested_at: string;
  status: "pending" | "approved" | "denied";
  reason?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  tool: string;
  tool_class: string;
  args_hash: string;
  decision: "allow" | "deny";
  decision_reason: string;
  result: string;
  created_at: string;
}

export interface Badge {
  slug: string;
  label: string;
  color: string;
  text_color: string;
}
export interface PamUser {
  username: string;
  uid: number;
  groups: string[];
  is_admin: boolean;
}
export interface Project {
  slug: string;
  name: string;
  description: string;
  repo_url: string;
  branch: string;
  created_at: string;
}
export type AgentRunState = "running" | "idle" | "stopped" | "error";
export type AgentHealth = "healthy" | "degraded" | "down" | "unknown";
export interface Agent {
  slug: string;
  name: string;
  description: string;
  state: AgentRunState;
  model: string;
  reasoning?: "low" | "medium" | "high";
  runtime?: "hermes" | "openclaw";
  modelProvider: string;
  health: AgentHealth;
  hermesUrl: string;
  uptimeSec: number;
  queueDepth: number;
  requestsPerMin: number;
  errorRatePct: number;
  p95LatencyMs: number;
  lastActivity: string;
}
export interface MailReview {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
  /** Sanitized HTML body (text/html MIME part). Empty when mail is plain-text
   *  or legacy row — UI then renders `body` as preformatted text. */
  bodyHtml?: string;
  spamScore: number | null;
  category: string | null;
  senderLegitimacy: string | null;
  classificationState: "scored" | "failed";
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "flagged";
  received_at: string;
}

export interface BackupSnapshot {
  id: string;
  target: string;
  kind: "zfs" | "docker-volume" | "postgres";
  createdAt: string;
  sizeBytes: number;
  retained: number;
  status: "ok" | "running" | "failed";
}

export interface SchedulerJob {
  id: string;
  name: string;
  cron: string;
  target: string;
  lastRun: string;
  nextRun: string;
  status: "ok" | "failing" | "paused";
  durationMs: number;
  enabled: boolean;
}
