// @vitest-environment node
/**
 * MP-024a scheduler bridge tests — listTimers parses live `systemctl list-timers`
 * output through a swappable executor (same fixed-argv/no-shell pattern as the
 * systemd domain).
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  listTimers,
  setSchedulerExecutorForTests,
  resetSchedulerForTests,
  type SchedulerExecutorResult,
} from "@/server/scheduler";

beforeEach(() => {
  resetSchedulerForTests();
});

const mockTimers = [
  {
    unit: "cortex-backup.timer",
    next: 1781222400000000,
    last: 1781179200108946,
    activates: "cortex-backup.service",
    description: "Run CortexOS encrypted full backup twice daily",
    schedule: "*-*-* 00,12:00:00",
    state: "active",
    enabled: true,
  },
  {
    unit: "cortex-mail-guardian-sweep.timer",
    next: 1781207761244856,
    last: 1781207461237706,
    activates: "cortex-mail-guardian-sweep.service",
    description: "Run Cortex Mail Guardian sweep every 5 minutes",
    schedule: "*-*-* *:00/5:00",
    state: "active",
    enabled: true,
  },
  {
    unit: "logrotate.timer",
    next: 0,
    last: 1781139599108723,
    activates: "logrotate.service",
    description: "Daily rotation of log files",
    schedule: "*-*-* 00:00:00",
    state: "inactive",
    enabled: false,
  },
];

function mockExecutor(stdout: string): () => Promise<SchedulerExecutorResult> {
  return async () => ({ stdout, stderr: "", exitCode: 0 });
}

describe("listTimers", () => {
  it("returns parsed rows from a mock list-timers JSON executor", async () => {
    setSchedulerExecutorForTests(mockExecutor(JSON.stringify(mockTimers)));
    const rows = await listTimers();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual([
      "cortex-backup.timer",
      "cortex-mail-guardian-sweep.timer",
      "logrotate.timer",
    ]);

    const backup = rows[0];
    if (!backup) throw new Error("Expected backup row at index 0");
    expect(backup.schedule).toBe("*-*-* 00,12:00:00");
    expect(backup.nextRun).toBe("2026-06-12T00:00:00.000Z");
    expect(backup.lastRun).toBe("2026-06-11T12:00:00.108Z");
    expect(backup.state).toBe("active");
    expect(backup.enabled).toBe(true);
    expect(backup.target).toBe("cortex-backup.service");

    const disabled = rows[2];
    if (!disabled) throw new Error("Expected disabled row at index 2");
    expect(disabled.nextRun).toBeNull();
    expect(disabled.enabled).toBe(false);
    expect(disabled.state).toBe("inactive");
  });

  it("reports unavailable when the executor exits non-zero", async () => {
    setSchedulerExecutorForTests(async () => ({ stdout: "", stderr: "failed", exitCode: 1 }));
    await expect(listTimers()).rejects.toThrow();
  });

  it("reports invalid inventory when the executor returns invalid JSON", async () => {
    setSchedulerExecutorForTests(async () => ({ stdout: "not-json", stderr: "", exitCode: 0 }));
    await expect(listTimers()).rejects.toThrow();
  });
});
