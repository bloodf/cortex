// @vitest-environment node
/**
 * Docker prune bridge tests (plan 0.5).
 *
 * Drives the bridge with an injected fake executor (no real docker). Asserts:
 *   - estimateReclaimable parses `docker system df` json into real bytes.
 *   - runPrune issues ONLY `image prune -f` + `builder prune -f` (argv asserted;
 *     NEVER `-a` / `--all` / `--volumes` / `docker system prune`).
 *   - failure paths return zeros / empty without throwing.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  estimateReclaimable,
  runPrune,
  parseDockerSize,
  setExecutorForTests,
  type Executor,
} from "../prune";

afterEach(() => {
  setExecutorForTests(null);
});

// Records every argv the bridge issues so we can assert exact commands.
function recordingExecutor(
  responder: (argv: readonly string[]) => { stdout?: string; stderr?: string; exitCode?: number },
): { exec: Executor; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Executor = async (argv) => {
    calls.push([...argv]);
    const r = responder(argv);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
  return { exec, calls };
}

const SYSTEM_DF_JSON = [
  '{"Active":"39","Reclaimable":"18.56GB (28%)","Size":"64.23GB","TotalCount":"70","Type":"Images"}',
  '{"Active":"39","Reclaimable":"0B (0%)","Size":"1.105GB","TotalCount":"39","Type":"Containers"}',
  '{"Active":"21","Reclaimable":"1.154MB (0%)","Size":"6.293GB","TotalCount":"27","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"663.6MB","Size":"16.42GB","TotalCount":"169","Type":"Build Cache"}',
].join("\n");

describe("parseDockerSize", () => {
  it("parses decimal SI units and ignores a trailing percentage", () => {
    expect(parseDockerSize("18.56GB (28%)")).toBe(Math.round(18.56 * 1000 ** 3));
    expect(parseDockerSize("663.6MB")).toBe(Math.round(663.6 * 1000 ** 2));
    expect(parseDockerSize("0B (0%)")).toBe(0);
  });

  it("returns 0 for unparseable input", () => {
    expect(parseDockerSize("")).toBe(0);
    expect(parseDockerSize("N/A")).toBe(0);
    expect(parseDockerSize("12 widgets")).toBe(0);
  });
});

describe("estimateReclaimable", () => {
  it("parses docker system df json into real bytes (images + build cache)", async () => {
    const { exec, calls } = recordingExecutor(() => ({ stdout: SYSTEM_DF_JSON }));
    setExecutorForTests(exec);

    const est = await estimateReclaimable();

    expect(calls).toEqual([["system", "df", "--format", "{{json .}}"]]);
    const images = Math.round(18.56 * 1000 ** 3);
    const buildCache = Math.round(663.6 * 1000 ** 2);
    expect(est.breakdown.images).toBe(images);
    expect(est.breakdown.buildCache).toBe(buildCache);
    expect(est.breakdown.containers).toBe(0);
    // Headline excludes volumes + containers; sums images + build cache.
    expect(est.reclaimableBytes).toBe(images + buildCache);
    expect(est.unavailable).toBeUndefined();
  });

  it("returns zeros + unavailable on a non-zero exit without throwing", async () => {
    const { exec } = recordingExecutor(() => ({
      stderr: "Cannot connect to the Docker daemon",
      exitCode: 1,
    }));
    setExecutorForTests(exec);

    const est = await estimateReclaimable();
    expect(est).toEqual({
      reclaimableBytes: 0,
      breakdown: { images: 0, buildCache: 0, containers: 0 },
      unavailable: true,
    });
  });

  it("returns zeros + unavailable on empty/garbage output without throwing", async () => {
    const { exec } = recordingExecutor(() => ({ stdout: "not json at all" }));
    setExecutorForTests(exec);

    const est = await estimateReclaimable();
    expect(est.unavailable).toBe(true);
    expect(est.reclaimableBytes).toBe(0);
  });
});

describe("runPrune", () => {
  it("issues ONLY `image prune -f` + `builder prune -f` and sums reclaimed", async () => {
    const { exec, calls } = recordingExecutor((argv) => {
      if (argv[0] === "image") return { stdout: "Total reclaimed space: 1.5GB" };
      if (argv[0] === "builder") return { stdout: "Total reclaimed space: 500MB" };
      return { stdout: "" };
    });
    setExecutorForTests(exec);

    const res = await runPrune();

    expect(calls).toEqual([
      ["image", "prune", "-f"],
      ["builder", "prune", "-f"],
    ]);
    // No dangerous flags anywhere.
    const flat = calls.flat();
    expect(flat).not.toContain("-a");
    expect(flat).not.toContain("--all");
    expect(flat).not.toContain("--volumes");
    expect(flat).not.toContain("system");
    expect(res.reclaimedBytes).toBe(Math.round(1.5 * 1000 ** 3) + Math.round(500 * 1000 ** 2));
  });

  it("returns 0 reclaimed when docker prints nothing parseable (no throw)", async () => {
    const { exec } = recordingExecutor(() => ({ stdout: "" }));
    setExecutorForTests(exec);

    const res = await runPrune();
    expect(res.reclaimedBytes).toBe(0);
    expect(res.raw).toBe("");
  });
});
