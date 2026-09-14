// @vitest-environment node
/**
 * MP-028 / item 1.2 — unit tests for the INLINE row-mappers that live in
 * `client.ts` (alerts / audit / approvals / incus) plus the `mapRowsSafe`
 * batch helper.
 *
 * The adapters layer historically had ZERO unit tests for these mappers — the
 * contract types claim string/uuid ids, but the live DB rows carry integer
 * serial ids, NULL fields, and `Date` objects. These tests feed those REAL
 * shapes and assert the edges the contract types would have hidden.
 *
 * The mappers are pure named exports, so we import them directly. (client.ts
 * loads fine under the node test env — see client-live-surface.test.ts.)
 */

import { describe, it, expect, vi } from "vitest";
import {
  mapRowsSafe,
  toAlertRuleRow,
  toAlertHistoryRow,
  toApprovalRequestRow,
  toAuditEntryRow,
  toIncusInstance,
} from "@/lib/api/client";

type AlertRuleInput = Parameters<typeof toAlertRuleRow>[0];
type AlertHistoryInput = Parameters<typeof toAlertHistoryRow>[0];
type ApprovalInput = Parameters<typeof toApprovalRequestRow>[0];
type AuditInput = Parameters<typeof toAuditEntryRow>[0];
type IncusInput = Parameters<typeof toIncusInstance>[0];

describe("toAlertRuleRow — integer serial id", () => {
  it("stringifies an integer id and threads fields through", () => {
    const input: AlertRuleInput = {
      id: 7,
      serviceId: 42,
      name: "Grafana down",
      condition: "status_offline",
      thresholdMs: null,
      enabled: true,
      createdAt: new Date("2026-06-15T00:00:00.000Z"),
      updatedAt: new Date("2026-06-15T00:00:00.000Z"),
    };
    const row = toAlertRuleRow(input);
    expect(row.id).toBe("7"); // integer id → string, not a uuid
    expect(row.service_id).toBe(42);
    expect(row.threshold_ms).toBeNull();
    expect(row.enabled).toBe(true);
  });
});

describe("toAlertHistoryRow — integer serial id", () => {
  it("stringifies an integer id", () => {
    const input: AlertHistoryInput = {
      id: 99,
      ruleName: "Grafana down",
      serviceName: "grafana",
      status: "firing",
      message: "offline > 60s",
      timestamp: "2026-06-15T01:00:00.000Z",
    };
    const row = toAlertHistoryRow(input);
    expect(row.id).toBe("99");
    expect(row.status).toBe("firing");
  });
});

describe("toApprovalRequestRow — integer id, Date, NULL decision", () => {
  it("maps a pending row (NULL decision) with a Date requestedAt", () => {
    const input: ApprovalInput = {
      id: 12,
      runId: "run-abc",
      role: null,
      issueId: null,
      signalName: "deploy.prod",
      reason: null,
      requestedAt: new Date("2026-06-15T02:00:00.000Z"),
      timeoutAt: null,
      resolvedAt: null,
      decision: null,
    } as ApprovalInput;
    const row = toApprovalRequestRow(input);
    expect(row.id).toBe("12");
    expect(row.status).toBe("pending");
    expect(row.requested_at).toBe("2026-06-15T02:00:00.000Z");
    expect(row.reason).toBeUndefined();
  });

  it("maps an approved decision", () => {
    const input = {
      id: 13,
      runId: "run-xyz",
      role: "owner",
      issueId: "ISSUE-1",
      signalName: "deploy.prod",
      reason: "looks good",
      requestedAt: "2026-06-15T02:00:00.000Z",
      timeoutAt: null,
      resolvedAt: "2026-06-15T02:05:00.000Z",
      decision: "approve",
    } as unknown as ApprovalInput;
    const row = toApprovalRequestRow(input);
    expect(row.status).toBe("approved");
    expect(row.reason).toBe("looks good");
  });
});

describe("toAuditEntryRow — NULL actor/result, payload-derived detail", () => {
  it("maps a row with NULL actor + result and derives decision from payload", () => {
    const input: AuditInput = {
      id: "evt-1",
      eventId: "evt-1",
      occurredAt: "2026-06-15T03:00:00.000Z",
      surface: "incus",
      action: "incus.restart",
      actor: null,
      subject: null,
      result: null,
      payloadHash: "hash123",
      payload: { detail: "restarted gastown", result: "error" },
    };
    const row = toAuditEntryRow(input);
    expect(row.actor).toBe(""); // NULL actor → empty string
    expect(row.result).toBe("error"); // falls back to payload.result
    expect(row.decision).toBe("deny"); // error result → deny
    expect(row.decision_reason).toBe("restarted gastown");
  });
});

describe("toIncusInstance — missing config/target + null devices", () => {
  function baseIncus(overrides: Partial<IncusInput> = {}): IncusInput {
    return {
      name: "gastown",
      slug: "gastown",
      status: "running",
      type: "container",
      image: "ubuntu/24.04",
      cpu: 2,
      memory: 4096,
      config: {
        target: {
          mode: "new",
          branch: "main",
          ghOrg: "example-org",
          slug: "gastown",
          description: "dev box",
        },
      },
      devices: {},
      lastValidation: null,
      createdBy: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      ...overrides,
    } as IncusInput;
  }

  it("maps a well-formed instance", () => {
    const row = toIncusInstance(baseIncus());
    expect(row.name).toBe("gastown");
    expect(row.project.name).toBe("gastown");
    expect(row.project.description).toBe("dev box");
  });

  it("does not throw when config.target is missing — falls back to slug/main", () => {
    const row = toIncusInstance(baseIncus({ config: {} as IncusInput["config"] }));
    expect(row.project.name).toBe("gastown"); // falls back to inst.slug
    expect(row.project.branch).toBe("main");
    expect(row.project.description).toBe("");
  });

  it("does not throw when config itself is null", () => {
    const row = toIncusInstance(baseIncus({ config: null as unknown as IncusInput["config"] }));
    expect(row.project.name).toBe("gastown");
  });

  it("does not throw when devices is null", () => {
    const row = toIncusInstance(baseIncus({ devices: null as unknown as IncusInput["devices"] }));
    expect(row.devices).toEqual({});
  });
});

describe("mapRowsSafe — drop one bad row, keep the rest, warn", () => {
  it("drops only the throwing row and warns with the row id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = mapRowsSafe(
      rows,
      (r) => {
        if (r.id === 2) throw new Error("boom on row 2");
        return r.id * 10;
      },
      "test",
    );
    expect(out).toEqual([10, 30]); // row 2 dropped, others kept
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("test");
    expect(warn.mock.calls[0][0]).toContain("id=2");
    warn.mockRestore();
  });

  it("returns all rows mapped when none throw", () => {
    const out = mapRowsSafe([{ id: 1 }, { id: 2 }], (r) => r.id, "ok");
    expect(out).toEqual([1, 2]);
  });

  it("falls back to the index when the row has no id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = mapRowsSafe(
      [{ v: "a" }, { v: "b" }],
      () => {
        throw new Error("always");
      },
      "noid",
    );
    expect(out).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain("id=0");
    expect(warn.mock.calls[1][0]).toContain("id=1");
    warn.mockRestore();
  });
});
