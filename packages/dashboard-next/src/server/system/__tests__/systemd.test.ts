// @vitest-environment node
/**
 * WP-13 bridge tests — dispatchAction security checks and mock executor.
 */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import type { SystemdUnit } from "@cortexos/contracts";

import {
  resetSystemdBridgeForTests,
  getMockExecutorForTests,
  SEED_UNITS,
  listUnits,
  getUnit,
  listLogs,
  dispatchAction,
  applyAction,
  managedUnitMetadata,
} from "@/server/system/systemd";
import { mintApproval, resetApprovalStore } from "@/server/approval";
import { asSessionId, asUserId } from "@/server/entities";
import type { User } from "@/server/entities";

beforeAll(() => {
  process.env.CORTEX_SYSTEMD_BRIDGE_REAL ??= "0";
  process.env.CORTEX_MASTER_KEY ??= "test-master-key-0123456789abcdef0123456789abcdef";
});

beforeEach(() => {
  resetSystemdBridgeForTests();
  resetApprovalStore();
});

const testUser: User = {
  id: asUserId("u1"),
  username: "admin",
  is_admin: true,
  isAdmin: true,
  isActive: true,
  groupMemberships: ["cortexos-admin"],
};

const baseCtx = {
  user: testUser,
  ip: "127.0.0.1",
  userAgent: "vitest",
  requestId: "req-001",
  sessionId: "sess-001",
};

// ---------------------------------------------------------------------------
// applyAction (pure function)
// ---------------------------------------------------------------------------

describe("applyAction", () => {
  it("start → active/running", () => {
    const unit = SEED_UNITS.find((u) => u.name === "redis-server.service")!;
    const next = applyAction(unit, "start");
    expect(next.active).toBe("active");
    expect(next.sub).toBe("running");
  });

  it("stop → inactive/dead", () => {
    const unit = SEED_UNITS.find((u) => u.name === "caddy.service")!;
    const next = applyAction(unit, "stop");
    expect(next.active).toBe("inactive");
    expect(next.sub).toBe("dead");
  });

  it("enable → enabled: true", () => {
    const unit = SEED_UNITS.find((u) => u.name === "unattended-upgrades.service")!;
    const next = applyAction(unit, "enable");
    expect(next.enabled).toBe(true);
  });

  it("disable → enabled: false", () => {
    const unit = SEED_UNITS.find((u) => u.name === "caddy.service")!;
    const next = applyAction(unit, "disable");
    expect(next.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listUnits / getUnit / listLogs
// ---------------------------------------------------------------------------

describe("listUnits", () => {
  it("returns the seeded units sorted by name", async () => {
    const units = await listUnits();
    expect(units.length).toBeGreaterThan(0);
    const names = units.map((u) => u.name);
    expect(names).toEqual([...names].sort());
  });

  it("includes caddy.service and postgresql.service", async () => {
    const units = await listUnits();
    const names = units.map((u) => u.name);
    expect(names).toContain("caddy.service");
    expect(names).toContain("postgresql.service");
  });

  it("derives live-unit metadata from the managed-unit policy", () => {
    expect(managedUnitMetadata("postgresql.service")).toEqual({
      allowlisted: true,
      critical: true,
    });
    expect(managedUnitMetadata("arbitrary-enumerated.service")).toEqual({
      allowlisted: false,
      critical: false,
    });
    expect(managedUnitMetadata("cortex-dashboard.service").allowlisted).toBe(true);
    expect(managedUnitMetadata("cortex-agent-sample-agent.service").allowlisted).toBe(true);
  });

  it("rejects dispatch on an arbitrary live-enumerated unmanaged unit", async () => {
    const unmanaged: SystemdUnit = {
      name: "arbitrary-enumerated.service",
      description: "an unmanaged host service",
      load: "loaded",
      active: "inactive",
      sub: "dead",
      enabled: false,
      type: "service",
      unitPath: null,
      ...managedUnitMetadata("arbitrary-enumerated.service"),
    };
    getMockExecutorForTests().seed([unmanaged]);
    const result = await dispatchAction(
      { action: "start", name: "arbitrary-enumerated.service" },
      baseCtx,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("not_allowlisted");
    }
  });
});

describe("getUnit", () => {
  it("returns a known unit", async () => {
    const unit = await getUnit("caddy.service");
    expect(unit).not.toBeNull();
    expect(unit!.name).toBe("caddy.service");
  });

  it("returns null for an unknown unit", async () => {
    const unit = await getUnit("nonexistent.service");
    expect(unit).toBeNull();
  });
});

describe("listLogs", () => {
  it("returns seed logs for a known unit", async () => {
    const lines = await listLogs("caddy.service", 100);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toHaveProperty("ts");
    expect(lines[0]).toHaveProperty("unit", "caddy.service");
  });

  it("returns empty for an unknown unit", async () => {
    const lines = await listLogs("nonexistent.service", 100);
    expect(lines).toEqual([]);
  });

  it("respects the limit", async () => {
    const mock = getMockExecutorForTests();
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      mock.pushLog("caddy.service", {
        ts: now,
        priority: "info",
        unit: "caddy.service",
        message: `msg ${i}`,
      });
    }
    const lines = await listLogs("caddy.service", 3);
    expect(lines.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — non-destructive
// ---------------------------------------------------------------------------

describe("dispatchAction — non-destructive (start, reload, enable)", () => {
  it("start on an allowlisted unit returns accepted", async () => {
    const result = await dispatchAction({ action: "start", name: "redis-server.service" }, baseCtx);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.unit.active).toBe("active");
    }
  });

  it("reload on an allowlisted unit returns accepted", async () => {
    const result = await dispatchAction({ action: "reload", name: "caddy.service" }, baseCtx);
    expect(result.status).toBe("accepted");
  });

  it("enable on an allowlisted unit returns accepted", async () => {
    const result = await dispatchAction({ action: "enable", name: "caddy.service" }, baseCtx);
    expect(result.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — unit-name security
// ---------------------------------------------------------------------------

describe("dispatchAction — unit name validation", () => {
  it("rejects a name with shell metacharacters", async () => {
    const result = await dispatchAction({ action: "start", name: "bad;unit" }, baseCtx);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unit_name_invalid");
    }
  });

  it("rejects an unknown unit", async () => {
    const result = await dispatchAction({ action: "start", name: "unknown.service" }, baseCtx);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unknown_unit");
    }
  });

  it("rejects a non-allowlisted unit", async () => {
    const result = await dispatchAction(
      { action: "start", name: "unattended-upgrades.service" },
      baseCtx,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("not_allowlisted");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — destructive actions require approval
// ---------------------------------------------------------------------------

describe("dispatchAction — destructive (stop, restart, disable)", () => {
  it("stop without approval token returns approval_required", async () => {
    const result = await dispatchAction({ action: "stop", name: "caddy.service" }, baseCtx);
    expect(result.status).toBe("approval_required");
    if (result.status === "approval_required") {
      expect(result.ttlSec).toBe(60);
      expect(typeof result.actionHash).toBe("string");
    }
  });

  it("restart without approval token returns approval_required", async () => {
    const result = await dispatchAction({ action: "restart", name: "caddy.service" }, baseCtx);
    expect(result.status).toBe("approval_required");
  });

  it("disable without approval token returns approval_required", async () => {
    const result = await dispatchAction({ action: "disable", name: "caddy.service" }, baseCtx);
    expect(result.status).toBe("approval_required");
  });

  it("stop with a valid approval token returns accepted", async () => {
    const sid = asSessionId("sess-001");
    const policyName = "systemd.stop";
    const { token } = mintApproval({
      action: policyName,
      payload: { name: "caddy.service" },
      sessionId: sid,
      userId: "u1",
      ttlSec: 60,
    });
    const result = await dispatchAction(
      { action: "stop", name: "caddy.service" },
      { ...baseCtx, sessionId: "sess-001", approvalToken: token },
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.unit.active).toBe("inactive");
    }
  });

  it("stop with a token for the wrong action hash returns rejected", async () => {
    const sid = asSessionId("sess-001");
    const { token } = mintApproval({
      action: "systemd.restart", // wrong action
      payload: { name: "caddy.service" },
      sessionId: sid,
      userId: "u1",
      ttlSec: 60,
    });
    const result = await dispatchAction(
      { action: "stop", name: "caddy.service" },
      { ...baseCtx, sessionId: "sess-001", approvalToken: token },
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("approval_invalid");
    }
  });

  it("stop with an already-used token is rejected (single-use)", async () => {
    const sid = asSessionId("sess-001");
    const { token } = mintApproval({
      action: "systemd.stop",
      payload: { name: "caddy.service" },
      sessionId: sid,
      userId: "u1",
      ttlSec: 60,
    });
    const ctx = { ...baseCtx, sessionId: "sess-001", approvalToken: token };
    const first = await dispatchAction({ action: "stop", name: "caddy.service" }, ctx);
    expect(first.status).toBe("accepted");

    resetSystemdBridgeForTests(); // reset so unit is active again
    const second = await dispatchAction({ action: "stop", name: "caddy.service" }, ctx);
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.code).toBe("approval_already_used");
    }
  });
});
