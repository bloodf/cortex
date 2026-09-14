// @vitest-environment node
/**
 * Dashboard command audit repository tests.
 *
 * The two-phase lifecycle (INSERT created → UPDATE finished) is the
 * contract under test:
 *
 *   1. startDashboardCommand() inserts a row with status='created'.
 *   2. finishDashboardCommand() updates the row by request_id with
 *      completion fields, including the metadata jsonb `||` merge.
 *
 * Also tested: list, get, count, and the two-phase read-after-write
 * (the row after finish reflects both the typed fields and the
 * metadata merge).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import {
  startDashboardCommand,
  finishDashboardCommand,
  listDashboardCommands,
  getDashboardCommandByRequestId,
  countDashboardCommands,
} from "../dashboard_command_audit";

let db: PgliteDbClient;
let client: PGlite;

beforeEach(async () => {
  const r = await createTestDb({ seed: true });
  db = r.db;
  client = r.client;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("dashboard_command_audit — two-phase lifecycle", () => {
  it("startDashboardCommand inserts a row with status='created'", async () => {
    const row = await startDashboardCommand(db, {
      requestId: "req-1",
      command: "docker",
      argv: ["ps"],
      envAllowlist: ["PATH", "HOME"],
    });
    expect(row.requestId).toBe("req-1");
    expect(row.status).toBe("created");
    expect(row.command).toBe("docker");
    expect(row.argv).toEqual(["ps"]);
    expect(row.envAllowlist).toEqual({ names: ["PATH", "HOME"] });
  });

  it("finishDashboardCommand updates the row with completion fields", async () => {
    await startDashboardCommand(db, {
      requestId: "req-2",
      command: "systemctl",
      argv: ["restart", "nginx"],
    });
    const finished = await finishDashboardCommand(db, "req-2", {
      status: "ok",
      exitCode: 0,
      stdoutBytes: 1024,
      stderrBytes: 0,
      finishedAt: new Date(),
    });
    expect(finished?.status).toBe("ok");
    expect(finished?.exitCode).toBe(0);
    expect(finished?.stdoutBytes).toBe(1024);
    expect(finished?.stderrBytes).toBe(0);
  });

  it("finishDashboardCommand merges metadata via jsonb ||", async () => {
    await startDashboardCommand(db, {
      requestId: "req-3",
      command: "echo",
      argv: ["hello"],
      metadata: { initial: true },
    });
    await finishDashboardCommand(db, "req-3", {
      status: "ok",
      metadata: { finished: true },
    });
    const got = await getDashboardCommandByRequestId(db, "req-3");
    // Both keys should be present (jsonb `||` is a merge, not replace).
    expect(got?.metadata).toEqual({ initial: true, finished: true });
  });

  it("finishDashboardCommand returns null for unknown requestId", async () => {
    const got = await finishDashboardCommand(db, "no-such-req", {
      status: "ok",
    });
    expect(got).toBeNull();
  });

  it("finishDashboardCommand rejects unexpected keys", async () => {
    await startDashboardCommand(db, {
      requestId: "req-4",
      command: "echo",
      argv: [],
    });
    await expect(
      finishDashboardCommand(db, "req-4", {
        status: "ok",
        // @ts-expect-error — testing the runtime guard
        notAColumn: "x",
      }),
    ).rejects.toThrow("unexpected key");
  });

  it("finishDashboardCommand requires status", async () => {
    await startDashboardCommand(db, {
      requestId: "req-5",
      command: "echo",
      argv: [],
    });
    await expect(
      finishDashboardCommand(db, "req-5", {
        // @ts-expect-error — testing the runtime guard
        status: undefined,
      }),
    ).rejects.toThrow("status is required");
  });

  it("startDashboardCommand rejects missing requestId", async () => {
    await expect(
      startDashboardCommand(db, {
        requestId: "",
        command: "echo",
        argv: [],
      }),
    ).rejects.toThrow("requestId is required");
  });

  it("startDashboardCommand rejects missing command", async () => {
    await expect(
      startDashboardCommand(db, {
        requestId: "req-6",
        command: "",
        argv: [],
      }),
    ).rejects.toThrow("command is required");
  });

  it("startDashboardCommand rejects non-array argv", async () => {
    await expect(
      startDashboardCommand(db, {
        requestId: "req-7",
        command: "echo",
        // @ts-expect-error — testing the runtime guard
        argv: "not-an-array",
      }),
    ).rejects.toThrow("argv must be an array");
  });

  it("two-phase row state is observable: get by requestId after finish", async () => {
    await startDashboardCommand(db, {
      requestId: "req-8",
      command: "docker",
      argv: ["ps", "-a"],
      requestedBy: "alice",
    });
    await finishDashboardCommand(db, "req-8", {
      status: "ok",
      exitCode: 0,
      stdoutSha256: "abc",
      stderrSha256: "def",
      journaldCursor: "s=abc123",
      startedAt: new Date("2026-06-03T12:00:00Z"),
      finishedAt: new Date("2026-06-03T12:00:01Z"),
    });
    const final = await getDashboardCommandByRequestId(db, "req-8");
    expect(final?.status).toBe("ok");
    expect(final?.exitCode).toBe(0);
    expect(final?.stdoutSha256).toBe("abc");
    expect(final?.stderrSha256).toBe("def");
    expect(final?.journaldCursor).toBe("s=abc123");
    expect(final?.startedAt).toBeInstanceOf(Date);
    expect(final?.finishedAt).toBeInstanceOf(Date);
    expect(final?.requestedBy).toBe("alice");
  });
});

describe("dashboard_command_audit — read paths", () => {
  beforeEach(async () => {
    // Seed a few rows.
    await startDashboardCommand(db, {
      requestId: "r1",
      command: "docker",
      argv: ["ps"],
    });
    await startDashboardCommand(db, {
      requestId: "r2",
      command: "systemctl",
      argv: ["status", "nginx"],
      requestedBy: "ops",
    });
    await finishDashboardCommand(db, "r1", { status: "ok" });
  });

  it("listDashboardCommands returns all rows", async () => {
    const rows = await listDashboardCommands(db);
    expect(rows.length).toBe(2);
  });

  it("listDashboardCommands filters by status", async () => {
    const ok = await listDashboardCommands(db, { status: "ok" });
    expect(ok.every((r) => r.status === "ok")).toBe(true);
  });

  it("listDashboardCommands filters by command", async () => {
    const docker = await listDashboardCommands(db, { command: "docker" });
    expect(docker.every((r) => r.command === "docker")).toBe(true);
  });

  it("listDashboardCommands filters by requestedBy", async () => {
    const ops = await listDashboardCommands(db, { requestedBy: "ops" });
    expect(ops.every((r) => r.requestedBy === "ops")).toBe(true);
  });

  it("listDashboardCommands filters by dashboardSessionId", async () => {
    await startDashboardCommand(db, {
      requestId: "r3",
      command: "echo",
      argv: [],
      dashboardSessionId: "sess-1",
    });
    const sess1 = await listDashboardCommands(db, {
      dashboardSessionId: "sess-1",
    });
    expect(sess1.every((r) => r.dashboardSessionId === "sess-1")).toBe(true);
  });

  it("countDashboardCommands returns the count", async () => {
    expect(await countDashboardCommands(db)).toBe(2);
  });

  it("listDashboardCommands paginates", async () => {
    const p1 = await listDashboardCommands(db, { limit: 1, offset: 0 });
    const p2 = await listDashboardCommands(db, { limit: 1, offset: 1 });
    expect(p1.length).toBe(1);
    expect(p2.length).toBe(1);
    expect(p1[0].id).not.toBe(p2[0].id);
  });
});
