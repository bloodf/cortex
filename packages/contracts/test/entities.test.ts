import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  // User
  UserSchema,
  UserInputSchema,
  SessionSchema,
  GroupMembershipSchema,
  ADMIN_GROUP_NAME,
  CurrentSessionSchema,
  LoginInputSchema,
  // Service
  ServiceSchema,
  ServiceInputSchema,
  ServiceUpdateSchema,
  BadgeSchema,
  BadgeInputSchema,
  ServiceHealthSnapshotSchema,
  UptimeStatSchema,
  UptimeIncidentSchema,
  // System
  SystemDataSchema,
  DriveInfoSchema,
  MountInfoSchema,
  NetworkInterfaceSchema,
  NetworkDataSchema,
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
  IncusInstanceConfigSchema,
  IncusLiveInstanceSchema,
  IncusImageSchema,
  ProgressStepSchema,
  ProgressReportSchema,
  IncusPreflightCheckSchema,
  IncusPreflightReportSchema,
  IncusShellInputSchema,
  IncusShellResultSchema,
  IncusActionInputSchema,
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
  // Personalization
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
} from '../src/entities/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round-trip a schema: parse -> serialize -> parse. */
const roundTrip = <T extends z.ZodTypeAny>(schema: T, value: unknown): unknown => {
  const parsed = schema.parse(value);
  const serialized = JSON.parse(JSON.stringify(parsed));
  return schema.parse(serialized);
};

const ISO = '2026-06-03T13:08:43-03:00';
const UUID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// User + Session
// ---------------------------------------------------------------------------

describe('entities — User', () => {
  it('parses a valid user', () => {
    const parsed = UserSchema.parse({
      id: UUID,
      username: 'alice',
      isAdmin: true,
      isActive: true,
      status: 'active',
      groupMemberships: [{ name: 'cortexos-admin', isAdmin: true }],
      createdAt: ISO,
      lastLoginAt: ISO,
      activeSessions: 0,
    });
    expect(parsed.isAdmin).toBe(true);
  });
  it('ADMIN_GROUP_NAME is cortexos-admin', () => {
    expect(ADMIN_GROUP_NAME).toBe('cortexos-admin');
  });
  it('GroupMembershipSchema defaults isAdmin to false', () => {
    const parsed = GroupMembershipSchema.parse({ name: 'docker' });
    expect(parsed.isAdmin).toBe(false);
  });
  it('rejects a username with uppercase', () => {
    expect(() =>
      UserSchema.parse({
        id: UUID,
        username: 'Alice',
        isAdmin: false,
        isActive: true,
        groupMemberships: [],
        createdAt: ISO,
        lastLoginAt: null,
        activeSessions: 0,
      }),
    ).toThrow();
  });
  it('UserInputSchema requires username and password', () => {
    expect(() => UserInputSchema.parse({})).toThrow();
  });
  it('UserInputSchema round-trips', () => {
    expect(roundTrip(UserInputSchema, { username: 'bob', password: 'p' })).toEqual({
      username: 'bob',
      password: 'p',
    });
  });
});

describe('entities — Session', () => {
  const validSession = {
    id: UUID,
    userId: UUID,
    csrfToken: 'a'.repeat(64),
    cookieToken: 'b'.repeat(64),
    expiresAt: ISO,
    createdAt: ISO,
    lastSeenAt: ISO,
    ip: '127.0.0.1',
    userAgent: 'Mozilla',
    isAdmin: false,
    lastRoleCheck: Date.now(),
  };
  it('parses a valid session', () => {
    const parsed = SessionSchema.parse(validSession);
    expect(parsed.id).toBe(UUID);
  });
  it('rejects a too-short CSRF token', () => {
    expect(() => SessionSchema.parse({ ...validSession, csrfToken: 'short' })).toThrow();
  });
  it('CurrentSessionSchema wraps user + session', () => {
    const parsed = CurrentSessionSchema.parse({
      user: {
        id: UUID,
        username: 'alice',
        isAdmin: false,
        isActive: true,
        groupMemberships: [],
        createdAt: ISO,
        lastLoginAt: null,
        activeSessions: 0,
      },
      session: validSession,
    });
    expect(parsed.user.username).toBe('alice');
  });
  it('LoginInputSchema round-trips', () => {
    expect(roundTrip(LoginInputSchema, { username: 'a', password: 'b' })).toEqual({
      username: 'a',
      password: 'b',
    });
  });
});

// ---------------------------------------------------------------------------
// Service + Badge
// ---------------------------------------------------------------------------

describe('entities — Service', () => {
  const validService = {
    id: UUID,
    slug: 'postgres',
    name: 'PostgreSQL',
    kind: 'service',
    category: 'Database',
    healthUrl: 'http://127.0.0.1:5432',
    healthType: 'tcp',
    openUrl: 'http://127.0.0.1:5432',
    status: 'online',
    sortOrder: 0,
    isActive: true,
    hasWebui: false,
    showInHealthcheck: true,
    showInWebui: true,
    badges: [],
    createdAt: ISO,
    updatedAt: ISO,
  };
  it('parses a valid service', () => {
    const parsed = ServiceSchema.parse(validService);
    expect(parsed.slug).toBe('postgres');
  });
  it('rejects an invalid slug', () => {
    expect(() => ServiceSchema.parse({ ...validService, slug: 'A_B' })).toThrow();
  });
  it('ServiceInputSchema defaults healthType to http when missing', () => {
    const parsed = ServiceInputSchema.parse({
      slug: 'svc',
      name: 'S',
      category: 'X',
      healthUrl: 'http://x',
    });
    expect(parsed.healthType).toBe('http');
  });
  it('ServiceInputSchema round-trips', () => {
    const input = {
      slug: 'svc',
      name: 'S',
      category: 'X',
      healthUrl: 'http://x',
      healthType: 'http' as const,
    };
    expect(roundTrip(ServiceInputSchema, input)).toMatchObject(input);
  });
  it('ServiceUpdateSchema requires an id', () => {
    expect(() => ServiceUpdateSchema.parse({ name: 'X' })).toThrow();
  });
  it('BadgeSchema requires slug + label', () => {
    expect(() => BadgeSchema.parse({ slug: 'b' })).toThrow();
  });
  it('BadgeInputSchema accepts a valid badge', () => {
    const parsed = BadgeInputSchema.parse({
      slug: 'core',
      label: 'Core',
      color: '#ff0000',
    });
    expect(parsed.color).toBe('#ff0000');
  });
  it('BadgeInputSchema rejects a non-hex color', () => {
    expect(() => BadgeInputSchema.parse({ slug: 'core', label: 'Core', color: 'red' })).toThrow();
  });
  it('ServiceHealthSnapshotSchema round-trips', () => {
    const v = {
      id: UUID,
      serviceId: UUID,
      status: 'online' as const,
      latencyMs: 12,
      checkedAt: ISO,
    };
    expect(roundTrip(ServiceHealthSnapshotSchema, v)).toMatchObject(v);
  });
  it('UptimeStatSchema round-trips', () => {
    const v = {
      serviceId: UUID,
      serviceSlug: 'postgres',
      window: '24h' as const,
      uptimePercent: 99.9,
      incidents: 0,
      totalChecks: 100,
      failedChecks: 1,
      windowStart: ISO,
      windowEnd: ISO,
    };
    expect(roundTrip(UptimeStatSchema, v)).toMatchObject(v);
  });
  it('UptimeStatSchema rejects a percent > 100', () => {
    expect(() =>
      UptimeStatSchema.parse({
        serviceId: UUID,
        serviceSlug: 'postgres',
        window: '24h',
        uptimePercent: 200,
        incidents: 0,
        totalChecks: 0,
        failedChecks: 0,
        windowStart: ISO,
        windowEnd: ISO,
      }),
    ).toThrow();
  });
  it('UptimeIncidentSchema accepts an open incident (no resolvedAt)', () => {
    const v = {
      serviceId: UUID,
      serviceSlug: 'postgres',
      startedAt: ISO,
      resolvedAt: null,
      durationSec: null,
    };
    expect(roundTrip(UptimeIncidentSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// System / host metrics
// ---------------------------------------------------------------------------

describe('entities — SystemData', () => {
  it('parses a minimal payload', () => {
    const parsed = SystemDataSchema.parse({
      cpu: 10,
      memory: { percent: 50, used: 100, total: 200, free: 100 },
      drives: [],
      mounts: [],
      load: [0.1, 0.2, 0.3],
      uptime: 3600,
      sensors: {},
      timestamp: ISO,
    });
    expect(parsed.cpu).toBe(10);
  });
  it('rejects load[0] < 0', () => {
    expect(() =>
      SystemDataSchema.parse({
        cpu: 10,
        memory: { percent: 50, used: 0, total: 0, free: 0 },
        drives: [],
        mounts: [],
        load: [-1, 0, 0],
        uptime: 0,
        sensors: {},
        timestamp: ISO,
      }),
    ).toThrow();
  });
  it('DriveInfoSchema accepts a typical drive', () => {
    expect(
      roundTrip(DriveInfoSchema, {
        name: 'sda',
        model: 'Samsung',
        size: 500_000_000_000,
        type: 'hdd',
      }),
    ).toMatchObject({ name: 'sda' });
  });
  it('MountInfoSchema rejects a percent > 100', () => {
    expect(() =>
      MountInfoSchema.parse({
        filesystem: '/dev/sda1',
        mount: '/',
        total: 100,
        used: 50,
        free: 50,
        percent: 200,
      }),
    ).toThrow();
  });
  it('NetworkInterfaceSchema round-trips', () => {
    const v = {
      name: 'eth0',
      rxKbps: 1.5,
      txKbps: 2.5,
      rxBytesTotal: 1000,
      txBytesTotal: 2000,
    };
    expect(roundTrip(NetworkInterfaceSchema, v)).toMatchObject(v);
  });
  it('NetworkDataSchema round-trips', () => {
    const v = {
      interfaces: [],
      timestamp: ISO,
    };
    expect(roundTrip(NetworkDataSchema, v)).toMatchObject(v);
  });
  it('ProcessInfoSchema round-trips', () => {
    const v = { pid: 1, user: 'root', cpu: 0, mem: 0, command: '/sbin/init' };
    expect(roundTrip(ProcessInfoSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

describe('entities — Docker', () => {
  it('DockerContainerSchema round-trips a running container', () => {
    const v = {
      id: 'sha256:'.padEnd(71, 'a'),
      name: 'grafana',
      image: 'grafana/grafana:11',
      state: 'running' as const,
      ports: ['3000:3000'],
      created: ISO,
      privileged: false,
      networks: ['cortex-net'],
      mounts: [],
    };
    expect(roundTrip(DockerContainerSchema, v)).toMatchObject(v);
  });
  it('DockerContainerSchema rejects an unknown state', () => {
    expect(() =>
      DockerContainerSchema.parse({
        id: 'sha256:aaa',
        name: 'x',
        image: 'x',
        state: 'drifting',
        ports: [],
        created: ISO,
      }),
    ).toThrow();
  });
  it('DockerImageSchema round-trips', () => {
    const v = {
      id: 'sha256:'.padEnd(71, 'a'),
      repo: 'grafana/grafana',
      tag: '11',
      size: 412_000_000,
      created: ISO,
    };
    expect(roundTrip(DockerImageSchema, v)).toMatchObject(v);
  });
  it('DockerVolumeSchema round-trips', () => {
    const v = {
      name: 'vol',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/vol',
    };
    expect(roundTrip(DockerVolumeSchema, v)).toMatchObject(v);
  });
  it('DockerNetworkSchema round-trips', () => {
    const v = {
      id: 'abc123def456',
      name: 'cortex-net',
      driver: 'bridge',
      scope: 'local' as const,
    };
    expect(roundTrip(DockerNetworkSchema, v)).toMatchObject(v);
  });
  it('DockerActionInputSchema accepts start with name', () => {
    expect(DockerActionInputSchema.parse({ action: 'start', name: 'grafana' })).toMatchObject({
      action: 'start',
      name: 'grafana',
    });
  });
  it('DockerActionInputSchema requires name for non-pull', () => {
    expect(() => DockerActionInputSchema.parse({ action: 'start' })).toThrow();
  });
  it('DockerActionInputSchema accepts pull without name', () => {
    expect(DockerActionInputSchema.parse({ action: 'pull', target: 'redis:7' })).toMatchObject({
      action: 'pull',
    });
  });
  it('DockerActionResultSchema round-trips', () => {
    const v = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(roundTrip(DockerActionResultSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Incus
// ---------------------------------------------------------------------------

describe('entities — Incus', () => {
  it('IncusInstanceConfigSchema round-trips a full config', () => {
    const v = {
      target: {
        mode: 'new' as const,
        repoUrl: 'https://example.com/repo',
        branch: 'main',
        ghOrg: 'example-org',
        slug: 'my-app',
        description: 'a thing',
      },
      image: {
        alias: 'ubuntu/24.04',
        gastown: false,
        profiles: ['default'],
        cpu: 2,
        memory: 4096,
        pool: 'default',
      },
      hermes: {
        enabled: true,
        profile: 'core',
        port: 8080,
        model: 'claude-opus',
        proxies: [],
      },
      network: {
        bridge: 'cortexbr0',
        tailscale: true,
        webAccess: false,
      },
    };
    expect(roundTrip(IncusInstanceConfigSchema, v)).toMatchObject(v);
  });
  it('IncusInstanceSchema round-trips', () => {
    const v = {
      name: 'my-app',
      slug: 'my-app',
      status: 'active' as const,
      type: 'container' as const,
      image: 'ubuntu/24.04',
      cpu: 2,
      memory: 4096,
      config: {
        target: { mode: 'new', branch: 'main', ghOrg: 'o', slug: 's' },
        image: { alias: 'ubuntu/24.04', gastown: false, profiles: [] },
        hermes: { enabled: false, proxies: [] },
        network: { bridge: 'b', tailscale: false, webAccess: false },
      },
      devices: {},
      lastValidation: null,
      createdBy: UUID,
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(roundTrip(IncusInstanceSchema, v)).toMatchObject({ name: 'my-app' });
  });
  it('IncusInstanceSchema rejects an invalid name', () => {
    expect(() =>
      IncusInstanceSchema.parse({
        name: 'My-App', // uppercase
        slug: 'my-app',
        status: 'active',
        type: 'container',
        image: 'ubuntu/24.04',
        config: {
          target: { mode: 'new', branch: 'main', ghOrg: 'o', slug: 's' },
          image: { alias: 'ubuntu/24.04', gastown: false, profiles: [] },
          hermes: { enabled: false, proxies: [] },
          network: { bridge: 'b', tailscale: false, webAccess: false },
        },
        devices: {},
        lastValidation: null,
        createdBy: UUID,
        createdAt: ISO,
        updatedAt: ISO,
      }),
    ).toThrow();
  });
  it('IncusLiveInstanceSchema round-trips a running instance', () => {
    const v = {
      name: 'my-app',
      status: 'RUNNING',
      statusCode: 'running' as const,
      type: 'container' as const,
      architecture: 'x86_64',
      createdAt: ISO,
      state: { networks: {} },
      profiles: ['default'],
      snapshots: [],
    };
    expect(roundTrip(IncusLiveInstanceSchema, v)).toMatchObject({ name: 'my-app' });
  });
  it('IncusImageSchema round-trips', () => {
    const v = {
      fingerprint: 'a'.repeat(64),
      architecture: 'x86_64',
      type: 'container' as const,
      size: 100_000_000,
      uploadedAt: ISO,
      aliases: ['ubuntu/24.04'],
    };
    expect(roundTrip(IncusImageSchema, v)).toMatchObject(v);
  });
  it('ProgressStepSchema round-trips', () => {
    const v = { step: 'init', status: 'ok' as const, n: 1, total: 5 };
    expect(roundTrip(ProgressStepSchema, v)).toMatchObject(v);
  });
  it('ProgressReportSchema round-trips', () => {
    const v = { status: 'running' as const, requestId: UUID, steps: [] };
    expect(roundTrip(ProgressReportSchema, v)).toMatchObject(v);
  });
  it('IncusPreflightCheckSchema round-trips', () => {
    const v = { id: 'c1', label: 'check', pass: true };
    expect(roundTrip(IncusPreflightCheckSchema, v)).toMatchObject(v);
  });
  it('IncusPreflightReportSchema round-trips', () => {
    const v = { ok: true, checks: [] };
    expect(roundTrip(IncusPreflightReportSchema, v)).toMatchObject(v);
  });
  it('IncusShellInputSchema requires op', () => {
    expect(() => IncusShellInputSchema.parse({ args: {} })).toThrow();
  });
  it('IncusShellInputSchema accepts each documented op', () => {
    ['term.ps', 'term.df', 'term.ls', 'term.cat', 'term.tail_log'].forEach((op) => {
      expect(IncusShellInputSchema.parse({ op, args: {} }).op).toBe(op);
    });
  });
  it('IncusShellResultSchema round-trips', () => {
    const v = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(roundTrip(IncusShellResultSchema, v)).toMatchObject(v);
  });
  it('IncusActionInputSchema requires name', () => {
    expect(() => IncusActionInputSchema.parse({ action: 'start' })).toThrow();
  });
  it('ProvisioningRequestSchema round-trips empty body', () => {
    expect(roundTrip(ProvisioningRequestSchema, {})).toEqual({});
  });
  it('ProvisioningResultSchema round-trips', () => {
    const v = {
      success: true,
      requestId: UUID,
      data: { status: 'running' as const, requestId: UUID, steps: [] },
    };
    expect(roundTrip(ProvisioningResultSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Systemd
// ---------------------------------------------------------------------------

describe('entities — Systemd', () => {
  it('SystemdUnitSchema round-trips', () => {
    const v = {
      name: 'cortex-dashboard.service',
      description: 'CortexOS Dashboard',
      load: 'loaded' as const,
      active: 'active' as const,
      sub: 'running',
      enabled: true,
      type: 'service',
    };
    expect(roundTrip(SystemdUnitSchema, v)).toMatchObject(v);
  });
  it('SystemdActionInputSchema rejects an unknown action', () => {
    expect(() => SystemdActionInputSchema.parse({ action: 'blow-up', name: 'x' })).toThrow();
  });
  it('SystemdActionInputSchema round-trips', () => {
    const v = { action: 'restart' as const, name: 'cortex-dashboard.service' };
    expect(roundTrip(SystemdActionInputSchema, v)).toMatchObject(v);
  });
  it('SystemdActionResultSchema round-trips', () => {
    const v = { stdout: '', stderr: '', exitCode: 0 };
    expect(roundTrip(SystemdActionResultSchema, v)).toMatchObject(v);
  });
  it('SystemdLogLineSchema round-trips', () => {
    const v = {
      ts: ISO,
      priority: 'info' as const,
      unit: 'cortex-dashboard.service',
      message: 'started',
    };
    expect(roundTrip(SystemdLogLineSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

describe('entities — Alert', () => {
  it('AlertRuleSchema round-trips', () => {
    const v = {
      id: UUID,
      name: 'pg-down',
      serviceId: UUID,
      condition: 'offline' as const,
      severity: 'critical' as const,
      channels: ['ui' as const],
      enabled: true,
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(roundTrip(AlertRuleSchema, v)).toMatchObject(v);
  });
  it('AlertRuleInputSchema requires thresholdMs only for response_time', () => {
    expect(() =>
      AlertRuleInputSchema.parse({
        name: 'pg-slow',
        condition: 'response_time',
      }),
    ).toThrow();
    expect(() =>
      AlertRuleInputSchema.parse({
        name: 'pg-slow',
        condition: 'offline',
        thresholdMs: 100,
      }),
    ).toThrow();
  });
  it('AlertRuleInputSchema accepts a response_time rule with threshold', () => {
    const parsed = AlertRuleInputSchema.parse({
      name: 'pg-slow',
      condition: 'response_time',
      thresholdMs: 100,
    });
    expect(parsed.thresholdMs).toBe(100);
  });
  it('AlertRuleUpdateSchema round-trips', () => {
    const v = { id: UUID, enabled: false };
    expect(roundTrip(AlertRuleUpdateSchema, v)).toMatchObject(v);
  });
  it('AlertEventSchema round-trips', () => {
    const v = {
      id: UUID,
      ruleId: UUID,
      ruleName: 'pg-down',
      serviceId: UUID,
      serviceName: 'pg',
      status: 'fired' as const,
      severity: 'critical' as const,
      message: 'down',
      firedAt: ISO,
      resolvedAt: null,
    };
    expect(roundTrip(AlertEventSchema, v)).toMatchObject(v);
  });
  it('OperationalAlertSchema round-trips', () => {
    const v = {
      id: UUID,
      severity: 'info' as const,
      title: 'backup done',
      message: 'last backup completed at 03:00',
      source: 'cortex-backup',
      createdAt: ISO,
      acknowledged: false,
    };
    expect(roundTrip(OperationalAlertSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Approval + command audit
// ---------------------------------------------------------------------------

describe('entities — Approval + command audit', () => {
  it('ApprovalRequestSchema round-trips', () => {
    const v = {
      id: UUID,
      actorId: UUID,
      actorUsername: 'alice',
      surface: 'systemd',
      tool: 'systemd.restart',
      summary: 'restart cortex-dashboard',
      argsPreview: { name: 'cortex-dashboard.service' },
      actionHash: 'a'.repeat(64),
      class: 'destructive' as const,
      requestedAt: ISO,
      status: 'pending' as const,
      decidedBy: null,
      decidedAt: null,
      reason: null,
      expiresAt: ISO,
    };
    expect(roundTrip(ApprovalRequestSchema, v)).toMatchObject(v);
  });
  it('ApprovalDecisionInputSchema requires id and decision', () => {
    expect(() => ApprovalDecisionInputSchema.parse({})).toThrow();
  });
  it('DashboardCommandAuditSchema round-trips', () => {
    const v = {
      id: UUID,
      requestId: UUID,
      requestedBy: UUID,
      command: 'systemd.restart',
      argv: ['/usr/bin/systemctl', 'restart', 'cortex-dashboard.service'],
      status: 'finished' as const,
      output: '',
      stderr: '',
      exitCode: 0,
      approvalHash: 'a'.repeat(64),
      createdAt: ISO,
      updatedAt: ISO,
      finishedAt: ISO,
    };
    expect(roundTrip(DashboardCommandAuditSchema, v)).toMatchObject(v);
  });
  it('DashboardCommandCreateSchema requires argv', () => {
    expect(() =>
      DashboardCommandCreateSchema.parse({
        requestId: UUID,
        command: 'x',
      }),
    ).toThrow();
  });
  it('DashboardCommandFinishSchema round-trips', () => {
    const v = { id: UUID, status: 'finished' as const, output: 'ok' };
    expect(roundTrip(DashboardCommandFinishSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Terminal + env-browser
// ---------------------------------------------------------------------------

describe('entities — Terminal + env-browser', () => {
  it('TerminalSessionSchema round-trips', () => {
    const v = {
      id: UUID,
      ownerId: UUID,
      connected: true,
      lastActivityAt: ISO,
      expiresAt: ISO,
      encoding: 'utf-8' as const,
      cols: 80,
      rows: 24,
    };
    expect(roundTrip(TerminalSessionSchema, v)).toMatchObject(v);
  });
  it('TerminalActionSchema accepts each action', () => {
    ['connect', 'exec', 'disconnect', 'resize'].forEach((action) => {
      expect(TerminalActionSchema.parse({ action, sessionId: UUID }).action).toBe(action);
    });
  });
  it('TerminalCommandSchema round-trips', () => {
    const v = {
      id: UUID,
      sessionId: UUID,
      op: 'term.ps' as const,
      argv: ['/usr/bin/ps', 'auxf'],
      startedAt: ISO,
    };
    expect(roundTrip(TerminalCommandSchema, v)).toMatchObject(v);
  });
  it('EnvLineSchema round-trips a kv line', () => {
    const v = {
      line: 1,
      raw: 'FOO=bar',
      type: 'kv' as const,
      key: 'FOO',
      value: 'bar',
      exported: false,
      masked: true,
    };
    expect(roundTrip(EnvLineSchema, v)).toMatchObject(v);
  });
  it('EnvFileSchema round-trips', () => {
    const v = {
      path: '/etc/cortex/secrets/x.env',
      lines: [],
    };
    expect(roundTrip(EnvFileSchema, v)).toMatchObject(v);
  });
  it('EnvEditInputSchema requires preWriteHash', () => {
    expect(() =>
      EnvEditInputSchema.parse({
        path: '/x',
        lineEdits: [{ line: 1, newRaw: 'X=y' }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Misc (Project, Notification, Backup, Scheduler)
// ---------------------------------------------------------------------------

describe('entities — Misc', () => {
  it('ProjectSchema round-trips', () => {
    const v = {
      id: UUID,
      slug: 'my-app',
      name: 'My App',
      repoUrl: 'https://example.com/repo',
      branch: 'main',
      messagingMode: 'single' as const,
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(roundTrip(ProjectSchema, v)).toMatchObject(v);
  });
  it('ProjectInputSchema accepts a valid input', () => {
    const v = { slug: 'my-app', name: 'My App' };
    expect(roundTrip(ProjectInputSchema, v)).toMatchObject(v);
  });
  it('ProjectUpdateSchema requires slug', () => {
    expect(() => ProjectUpdateSchema.parse({ name: 'X' })).toThrow();
  });
  it('NotificationEntrySchema round-trips', () => {
    const v = {
      id: UUID,
      channel: 'ui' as const,
      message: 'x',
      sentAt: ISO,
      status: 'delivered' as const,
    };
    expect(roundTrip(NotificationEntrySchema, v)).toMatchObject(v);
  });
  it('BackupSnapshotSchema round-trips', () => {
    const v = {
      id: UUID,
      name: 'snap-1.tar.gz',
      createdAt: ISO,
      size: 1_000_000,
      status: 'ok' as const,
      location: '/mnt/nas',
    };
    expect(roundTrip(BackupSnapshotSchema, v)).toMatchObject(v);
  });
  it('ScheduledJobSchema round-trips', () => {
    const v = {
      name: 'cortex-backup.timer',
      description: 'nightly backup',
      schedule: '*-*-* 03:00:00',
      nextRun: ISO,
      lastRun: ISO,
      lastResult: 'ok' as const,
      enabled: true,
    };
    expect(roundTrip(ScheduledJobSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Personalization + AI
// ---------------------------------------------------------------------------

describe('entities — Personalization + AI', () => {
  it('WidgetPositionSchema round-trips', () => {
    const v = { x: 0, y: 0, w: 4, h: 2 };
    expect(roundTrip(WidgetPositionSchema, v)).toMatchObject(v);
  });
  it('WidgetConfigSchema round-trips', () => {
    const v = {
      id: 'cpu',
      type: 'cpu-widget',
      position: { x: 0, y: 0, w: 4, h: 2 },
      settings: {},
    };
    expect(roundTrip(WidgetConfigSchema, v)).toMatchObject(v);
  });
  it('DashboardLayoutSchema round-trips', () => {
    const v = {
      id: UUID,
      userId: null,
      widgets: [],
      version: 1,
      updatedAt: ISO,
    };
    expect(roundTrip(DashboardLayoutSchema, v)).toMatchObject(v);
  });
  it('AppPreferenceSchema round-trips a string value', () => {
    const v = {
      key: 'theme.mode' as const,
      value: 'dark',
      userId: UUID,
      updatedAt: ISO,
    };
    expect(roundTrip(AppPreferenceSchema, v)).toMatchObject(v);
  });
  it('AppPreferenceSchema round-trips a favorites array', () => {
    const v = {
      key: 'favorites' as const,
      value: ['svc1', 'svc2'],
      userId: UUID,
      updatedAt: ISO,
    };
    expect(roundTrip(AppPreferenceSchema, v)).toMatchObject(v);
  });
  it('LogEntrySchema round-trips', () => {
    const v = {
      id: UUID,
      ts: ISO,
      source: 'systemd',
      level: 'info' as const,
      message: 'started',
    };
    expect(roundTrip(LogEntrySchema, v)).toMatchObject(v);
  });
  it('AIToolDefinitionSchema round-trips', () => {
    const v = {
      name: 'read_file',
      description: 'read a file',
      policyClass: 'free' as const,
      rateLimitPerMin: 60,
      cooldownSec: 0,
      argsSchema: { type: 'object' },
    };
    expect(roundTrip(AIToolDefinitionSchema, v)).toMatchObject(v);
  });
  it('AIRequestSchema requires messages', () => {
    expect(() => AIRequestSchema.parse({})).toThrow();
  });
  it('AIRequestSchema round-trips', () => {
    const v = {
      messages: [
        { role: 'system', content: 'You are a helper' },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(roundTrip(AIRequestSchema, v)).toMatchObject(v);
  });
  it('AIResponseSchema round-trips', () => {
    const v = {
      id: UUID,
      model: 'claude-opus',
      text: 'hello',
      toolCalls: [],
      usage: null,
      createdAt: ISO,
    };
    expect(roundTrip(AIResponseSchema, v)).toMatchObject(v);
  });
  it('AIResponseChunkSchema accepts a text chunk', () => {
    const parsed = AIResponseChunkSchema.parse({ type: 'text', text: 'hi' });
    expect(parsed.type).toBe('text');
  });
  it('AIResponseChunkSchema accepts a tool_call chunk', () => {
    const parsed = AIResponseChunkSchema.parse({
      type: 'tool_call',
      toolCall: { id: '1', name: 'x', args: {} },
    });
    expect(parsed.type).toBe('tool_call');
  });
  it('MailReviewSchema round-trips', () => {
    const v = {
      id: UUID,
      accountSlug: 'gmail-main',
      messageUid: '1',
      modelVerdict: 'spam' as const,
      modelConfidence: 0.9,
      requestedAt: ISO,
    };
    expect(roundTrip(MailReviewSchema, v)).toMatchObject(v);
  });
  it('MailDecisionInputSchema round-trips', () => {
    const v = { id: UUID, decision: 'keep' as const };
    expect(roundTrip(MailDecisionInputSchema, v)).toMatchObject(v);
  });
  it('AgentSchema round-trips', () => {
    const v = {
      slug: 'cortex-doctor',
      name: 'Cortex Doctor',
      files: [],
    };
    expect(roundTrip(AgentSchema, v)).toMatchObject(v);
  });
  it('AgentFileSchema round-trips', () => {
    const v = { name: 'config.json', path: '/opt/x/config.json' };
    expect(roundTrip(AgentFileSchema, v)).toMatchObject(v);
  });
  it('AgentFileContentSchema round-trips', () => {
    const v = { name: 'config.json', path: '/x', content: '{}' };
    expect(roundTrip(AgentFileContentSchema, v)).toMatchObject(v);
  });
});

// ---------------------------------------------------------------------------
// Sanity: every schema's key fields are reachable via .parse
// ---------------------------------------------------------------------------

describe('sanity — exhaustive parse coverage', () => {
  it('all major entities are importable and parseable', () => {
    // A simple smoke test: confirm a representative subset parses valid input.
    const samples: [string, z.ZodTypeAny, unknown][] = [
      [
        'ServiceSchema',
        ServiceSchema,
        {
          id: UUID,
          slug: 'svc',
          name: 'S',
          kind: 'service',
          category: 'C',
          healthUrl: 'http://x',
          healthType: 'http',
          openUrl: 'http://x',
          status: 'online',
          sortOrder: 0,
          isActive: true,
          hasWebui: false,
          showInHealthcheck: true,
          showInWebui: true,
          badges: [],
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      [
        'DockerContainerSchema',
        DockerContainerSchema,
        {
          id: 'sha256:'.padEnd(71, 'a'),
          name: 'c',
          image: 'i',
          state: 'running',
          ports: [],
          created: ISO,
          privileged: false,
          networks: [],
          mounts: [],
        },
      ],
      [
        'IncusImageSchema',
        IncusImageSchema,
        {
          fingerprint: 'a'.repeat(64),
          architecture: 'x86_64',
          type: 'container',
          size: 1,
          uploadedAt: ISO,
          aliases: [],
        },
      ],
      [
        'SystemdUnitSchema',
        SystemdUnitSchema,
        {
          name: 'x',
          description: '',
          load: 'loaded',
          active: 'active',
          sub: 'running',
          enabled: true,
          type: 'service',
        },
      ],
      [
        'AlertRuleSchema',
        AlertRuleSchema,
        {
          id: UUID,
          name: 'x',
          serviceId: null,
          condition: 'offline',
          severity: 'warning',
          channels: ['ui'],
          enabled: true,
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
    ];
    samples.forEach(([name, schema, value]) => {
      const result = schema.safeParse(value);
      expect(result.success, `${name} failed: ${JSON.stringify(result)}`).toBe(true);
    });
  });
});
