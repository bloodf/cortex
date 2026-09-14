// @vitest-environment node
/**
 * MP-025 — client live-surface contract tests.
 *
 * Mocks the underlying server-function modules and asserts that the nine
 * previously-stubbed `api.*` entries call the matching server fn and return
 * the contract-mapped value instead of rejecting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { api } from "@/lib/api/client";
import type * as AgentsFunctions from "@/lib/api/agents.functions";

const mockListAlerts = vi.fn();
const mockAlertHistory = vi.fn();
const mockListApprovals = vi.fn();
const mockListAudit = vi.fn();
const mockListAgents = vi.fn();
const mockReadEnv = vi.fn();
const mockListEnvFiles = vi.fn();
const mockListInstances = vi.fn();
const mockListImages = vi.fn();
const mockListVolumes = vi.fn();
const mockListNotifications = vi.fn();

vi.mock("@/lib/api/alerts.functions", () => ({
  listAlerts: (...args: unknown[]) => mockListAlerts(...args),
  alertHistory: (...args: unknown[]) => mockAlertHistory(...args),
  createAlert: vi.fn(),
  patchAlert: vi.fn(),
  deleteAlert: vi.fn(),
  listNotifications: (...args: unknown[]) => mockListNotifications(...args),
  markNotificationsRead: vi.fn(),
}));

vi.mock("@/lib/api/approvals.functions", () => ({
  listApprovals: (...args: unknown[]) => mockListApprovals(...args),
  listAudit: (...args: unknown[]) => mockListAudit(...args),
  mintApproval: vi.fn(),
  verifyAudit: vi.fn(),
  grantApproval: vi.fn(),
  revokeApproval: vi.fn(),
  deleteApproval: vi.fn(),
}));

vi.mock("@/lib/api/agents.functions", async () => {
  const actual = await vi.importActual<typeof AgentsFunctions>(
    "@/lib/api/agents.functions",
  );
  return {
    ...actual,
    listAgents: (...args: unknown[]) => mockListAgents(...args),
    uploadAgentFile: vi.fn(),
    agentStatuses: vi.fn(),
    agentAction: vi.fn(),
    agentChat: vi.fn(),
    setAgentModel: vi.fn(),
  };
});

vi.mock("@/lib/api/env-browser.functions", () => ({
  listEnvFiles: (...args: unknown[]) => mockListEnvFiles(...args),
  readEnv: (...args: unknown[]) => mockReadEnv(...args),
  unlock: vi.fn(),
}));

vi.mock("@/lib/api/incus.functions", () => ({
  listInstances: (...args: unknown[]) => mockListInstances(...args),
  incusAction: vi.fn(),
  instanceLogs: vi.fn(),
}));

vi.mock("@/lib/api/docker.functions", () => ({
  listContainers: vi.fn(),
  listImages: (...args: unknown[]) => mockListImages(...args),
  listVolumes: (...args: unknown[]) => mockListVolumes(...args),
  dockerAction: vi.fn(),
  containerLogs: vi.fn(),
  dockerPruneEstimate: vi.fn(),
  dockerPrune: vi.fn(),
}));

beforeEach(() => {
  mockListAlerts.mockReset();
  mockAlertHistory.mockReset();
  mockListApprovals.mockReset();
  mockListAudit.mockReset();
  mockListAgents.mockReset();
  mockReadEnv.mockReset();
  mockListInstances.mockReset();
  mockListImages.mockReset();
  mockListVolumes.mockReset();
});

const iso = "2026-06-11T20:00:00.000Z";

describe("MP-025 live client surface", () => {
  it("api.alerts.rules calls listAlerts and returns mapped AlertRule rows", async () => {
    mockListAlerts.mockResolvedValue({
      rules: [
        {
          id: 1,
          serviceId: 2,
          name: "offline-rule",
          condition: "offline",
          thresholdMs: null,
          enabled: true,
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    });

    const result = await api.alerts.rules();

    expect(mockListAlerts).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "1",
      service_id: 2,
      name: "offline-rule",
      condition: "offline",
      threshold_ms: null,
      enabled: true,
    });
  });

  it("api.alerts.rulesList calls listAlerts and returns a paginated ListResult<AlertRule>", async () => {
    mockListAlerts.mockResolvedValue({
      rules: [
        {
          id: 5,
          serviceId: 9,
          name: "rt-rule",
          condition: "response_time",
          thresholdMs: 250,
          enabled: false,
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    });

    const result = await api.alerts.rulesList({ page: 0, pageSize: 10, q: "rt" });

    expect(mockListAlerts).toHaveBeenCalledTimes(1);
    expect(result.rows[0]).toEqual({
      id: "5",
      service_id: 9,
      name: "rt-rule",
      condition: "response_time",
      threshold_ms: 250,
      enabled: false,
    });
    expect(result.total).toBe(1);
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(10);
  });

  it("api.alerts.history calls alertHistory and returns mapped AlertHistory rows", async () => {
    mockAlertHistory.mockResolvedValue({
      history: [
        {
          id: 7,
          ruleName: "offline-rule",
          serviceName: "router",
          status: "fired",
          message: "service offline",
          timestamp: iso,
        },
      ],
    });

    const result = await api.alerts.history();

    expect(mockAlertHistory).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "7",
      ruleName: "offline-rule",
      serviceName: "router",
      status: "fired",
      message: "service offline",
      timestamp: iso,
    });
  });

  it("api.alerts.historyList calls alertHistory and returns a paginated ListResult<AlertHistory>", async () => {
    mockAlertHistory.mockResolvedValue({
      history: [
        {
          id: 8,
          ruleName: "rt-rule",
          serviceName: "apps",
          status: "resolved",
          message: "recovered",
          timestamp: iso,
        },
      ],
    });

    const result = await api.alerts.historyList({ page: 0, pageSize: 5 });

    expect(mockAlertHistory).toHaveBeenCalledTimes(1);
    expect(result.rows[0]).toEqual({
      id: "8",
      ruleName: "rt-rule",
      serviceName: "apps",
      status: "resolved",
      message: "recovered",
      timestamp: iso,
    });
    expect(result.total).toBe(1);
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(5);
  });

  it("api.approvals calls listApprovals and returns mapped ApprovalRequest rows", async () => {
    mockListApprovals.mockResolvedValue({
      pending: [
        {
          id: 3,
          runId: "run-abc",
          signalName: "docker.stop",
          role: "admin",
          issueId: null,
          reason: "maintenance",
          requestedAt: iso,
          timeoutAt: null,
          resolvedAt: null,
          decision: null,
          approver: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });

    const result = await api.approvals();

    expect(mockListApprovals).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "3",
      actor: "run-abc",
      tool: "docker.stop",
      summary: "docker.stop",
      args_preview: JSON.stringify({ runId: "run-abc", role: "admin" }),
      requested_at: iso,
      status: "pending",
      reason: "maintenance",
    });
  });

  it("api.audit calls listAudit with pageSize 500 and returns mapped AuditEntry rows", async () => {
    mockListAudit.mockResolvedValue({
      events: [
        {
          id: "100",
          eventId: "ev-1",
          occurredAt: iso,
          surface: "docker",
          action: "stop",
          actor: "admin",
          subject: "container-x",
          result: "ok",
          payloadHash: "ph-100",
          payload: { result: "ok", detail: "stopped cleanly" },
        },
      ],
      surfaces: ["docker"],
      actions: ["stop"],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    const result = await api.audit();

    expect(mockListAudit).toHaveBeenCalledTimes(1);
    expect(mockListAudit).toHaveBeenCalledWith({ data: { pageSize: 500 } });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "100",
      actor: "admin",
      tool: "stop",
      tool_class: "docker",
      args_hash: "ph-100",
      decision: "allow",
      decision_reason: "stopped cleanly",
      result: "ok",
      created_at: iso,
    });
  });

  it("api.auditList calls listAudit, forwards page/pageSize, and returns server pagination totals", async () => {
    mockListAudit.mockResolvedValue({
      events: [
        {
          id: "101",
          eventId: "ev-2",
          occurredAt: iso,
          surface: "systemd",
          action: "restart",
          actor: "operator",
          subject: "nginx",
          result: "deny",
          payloadHash: "ph-101",
          payload: { result: "deny", detail: "policy rejected" },
        },
      ],
      surfaces: ["systemd"],
      actions: ["restart"],
      total: 120,
      page: 1,
      pageSize: 50,
    });

    const result = await api.auditList({ page: 0, pageSize: 50 });

    expect(mockListAudit).toHaveBeenCalledTimes(1);
    expect(mockListAudit).toHaveBeenCalledWith({ data: { page: 1, pageSize: 50 } });
    expect(result.rows[0]).toEqual({
      id: "101",
      actor: "operator",
      tool: "restart",
      tool_class: "systemd",
      args_hash: "ph-101",
      decision: "deny",
      decision_reason: "policy rejected",
      result: "deny",
      created_at: iso,
    });
    expect(result.total).toBe(120);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
  });

  it("api.agents calls listAgents and returns mapped Agent rows", async () => {
    mockListAgents.mockResolvedValue({
      agents: [
        {
          profile: "orchestrator",
          home: "/var/lib/cortex/hermes/profiles/orchestrator",
          apiPort: 8001,
          model: "claude-sonnet-4-5",
          reasoning: "medium",
          hindsightBank: "ops",
          secretPath: "/etc/cortex/secrets/orchestrator.env",
          apps: ["dashboard"],
        },
      ],
    });

    const result = await api.agents();

    expect(mockListAgents).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: "orchestrator",
      name: "orchestrator",
      description: "Hermes profile: orchestrator",
      state: "stopped",
      model: "claude-sonnet-4-5",
      modelProvider: "anthropic",
      health: "unknown",
      hermesUrl: "http://localhost:8001",
      uptimeSec: 0,
      queueDepth: 0,
      requestsPerMin: 0,
      errorRatePct: 0,
      p95LatencyMs: 0,
    });
    expect(typeof result[0].lastActivity).toBe("string");
  });

  it("api.envFiles calls readEnv and returns mapped env file rows", async () => {
    mockListEnvFiles.mockResolvedValue({ files: ["/srv/example/stacks/router.env"] });
    mockReadEnv.mockResolvedValue({
      path: "/srv/example/stacks/router.env",
      revealed: false,
      revealExpiresAt: null,
      entries: [
        { key: "OPENAI_API_KEY", value: "••••••••xyz1", masked: "••••••••xyz1" },
        { key: "BUDGET_USD", value: "20", masked: "20" },
      ],
    });

    const result = await api.envFiles();

    expect(mockReadEnv).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        path: "/srv/example/stacks/router.env",
        keys: ["OPENAI_API_KEY", "BUDGET_USD"],
      },
    ]);
  });

  it("api.incus carries null cpu/memory instead of defaulting to 0", async () => {
    mockListInstances.mockResolvedValue({
      items: [
        {
          name: "null-spec",
          slug: "null-spec",
          status: "active",
          type: "container",
          image: "ubuntu/24.04",
          cpu: null,
          memory: null,
          config: {
            target: {
              slug: "null-spec",
              description: "test project",
              repoUrl: "",
              branch: "main",
            },
          },
          devices: {},
          lastValidation: null,
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    });

    const result = await api.incus();

    expect(mockListInstances).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].cpu).toBeNull();
    expect(result[0].memory).toBeNull();
  });

  it("api.docker.images carries null size instead of defaulting to 0", async () => {
    mockListImages.mockResolvedValue({
      items: [
        {
          id: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          repo: "null-size",
          tag: "latest",
          size: null,
          created: iso,
        },
      ],
    });

    const result = await api.docker.images();

    expect(mockListImages).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].size).toBeNull();
  });

  it("api.docker.volumes carries null size instead of defaulting to 0", async () => {
    mockListVolumes.mockResolvedValue({
      items: [
        {
          name: "null-size-vol",
          driver: "local",
          mountpoint: "/var/lib/docker/volumes/null-size-vol/_data",
          size: null,
          createdAt: iso,
          labels: {},
        },
      ],
    });

    const result = await api.docker.volumes();

    expect(mockListVolumes).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].size).toBeNull();
  });
});
