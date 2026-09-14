// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listBackupRuns,
  setBackupExecutorForTests,
  setBackupsRootForTests,
  resetBackupsForTests,
  type BackupExecutor,
} from "@/server/backups";

const roots: string[] = [];
beforeEach(() => {
  resetBackupsForTests();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetBackupsForTests();
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "backups-test-"));
  roots.push(root);
  return root;
}

function mockExecutor(root: string, state = "inactive\ndead\n"): BackupExecutor {
  return async (argv) => ({
    stdout: argv.includes("--property=Environment") ? `Environment=BACKUP_ROOT=${root}` : state,
    stderr: "",
    exitCode: 0,
  });
}

function publish(root: string, stamp: string, overrides: Record<string, unknown> = {}): string {
  const archive = path.join(root, `cortex-${stamp}.tar.gz`);
  writeFileSync(archive, "synthetic-archive");
  writeFileSync(path.join(root, `cortex-${stamp}.json`), JSON.stringify({
    schema_version: 1,
    archive,
    created_utc: stamp,
    manifest: "/etc/cortex/install.json",
    services: ["dashboard", "postgresql"],
    paths: ["/var/lib/cortex"],
    state: "verified-cold-archive",
    ...overrides,
  }));
  return archive;
}

describe("listBackupRuns", () => {
  it("maps verified archives and failed partials, preserving microsecond ordering", async () => {
    const root = makeRoot();
    const first = "20260914T120000.123456Z";
    const second = "20260914T120000.123457Z";
    const current = "20260915T120000.000000Z";
    const archive = publish(root, first);
    publish(root, second);
    writeFileSync(path.join(root, `cortex-${current}.tar.partial`), "incomplete");
    writeFileSync(path.join(root, "README.txt"), "ignore me");
    setBackupExecutorForTests(mockExecutor(root, "failed\nfailed\n"));

    const rows = await listBackupRuns();
    expect(rows.map((row) => row.id)).toEqual([current, second, first]);
    expect(rows[2]).toEqual({
      id: first,
      timestamp: "2026-09-14T12:00:00.123456Z",
      target: archive,
      sizeBytes: Buffer.byteLength("synthetic-archive"),
      status: "success",
    });
    expect(rows[0]).toMatchObject({ status: "failed", sizeBytes: null });
  });

  it("marks only the newest partial running and prefers a published archive over its partial", async () => {
    const root = makeRoot();
    const completed = "20260914T120000.000000Z";
    const current = "20260915T120000.000000Z";
    publish(root, completed);
    writeFileSync(path.join(root, `cortex-${completed}.tar.partial`), "old partial");
    writeFileSync(path.join(root, `cortex-${current}.tar.partial`), "current partial");
    setBackupExecutorForTests(mockExecutor(root, "active\nrunning\n"));

    const rows = await listBackupRuns();
    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: current, status: "running" },
      { id: completed, status: "success" },
    ]);
  });

  it("does not declare success from missing, malformed, mismatched or unverified receipts", async () => {
    const root = makeRoot();
    const stamps = [0, 1, 2, 3, 4, 5].map((n) => `20260914T12000${n}.000000Z`);
    const missing = publish(root, stamps[0]);
    rmSync(path.join(root, `cortex-${stamps[0]}.json`));
    publish(root, stamps[1]);
    writeFileSync(path.join(root, `cortex-${stamps[1]}.json`), "{broken");
    publish(root, stamps[2], { state: "pending" });
    publish(root, stamps[3], { archive: missing });
    publish(root, stamps[4], { created_utc: stamps[0] });
    publish(root, stamps[5], { schema_version: 2 });
    setBackupExecutorForTests(mockExecutor(root));

    const rows = await listBackupRuns();
    expect(rows.map((row) => row.status)).toEqual(Array(6).fill("unknown"));
  });

  it("ignores invalid dates, archive-shaped directories, symlinks and orphan receipts", async () => {
    const root = makeRoot();
    publish(root, "20260230T120000.000000Z");
    mkdirSync(path.join(root, "cortex-20260914T120000.000000Z.tar.gz"));
    symlinkSync(path.join(root, "README.txt"), path.join(root, "cortex-20260914T120001.000000Z.tar.gz"));
    writeFileSync(path.join(root, "README.txt"), "not an archive");
    publish(root, "20260914T120002.000000Z");
    rmSync(path.join(root, "cortex-20260914T120002.000000Z.tar.gz"));
    setBackupExecutorForTests(mockExecutor(root));
    expect(await listBackupRuns()).toEqual([]);
  });

  it("returns no rows when the backup destination is absent", async () => {
    setBackupExecutorForTests(mockExecutor(path.join(makeRoot(), "absent")));
    expect(await listBackupRuns()).toEqual([]);
  });

  it("uses the configured fallback when systemctl is unavailable", async () => {
    const root = makeRoot();
    publish(root, "20260914T120000.000000Z");
    setBackupExecutorForTests(async () => ({ stdout: "", stderr: "unavailable", exitCode: 1 }));
    setBackupsRootForTests(root);
    expect((await listBackupRuns()).map((row) => row.status)).toEqual(["success"]);
  });
});
