// @vitest-environment node
/**
 * MP-009 — real-data `tailLogs` stderr merge test.
 *
 * `docker logs` writes the container's stderr stream to the CLI's stderr
 * (and stdout to CLI's stdout). The current `tailLogs` impl only destructures
 * `stdout` from `execFile` — the stderr stream is silently dropped, so any
 * container that emits errors via stderr (very common) shows up blank.
 *
 * This test stubs `node:child_process.execFile` (the only runtime call
 * inside the CORTEX_DOCKER_REAL=1 path of `tailLogs`) to return distinct
 * payloads on stdout and stderr, then asserts both appear in the returned
 * string[]. MUST fail before the merge is implemented; PASS after.
 *
 * Pattern: vi.mock the node built-in BEFORE importing real-data, then
 * configure the mock per-test via the captured `execFileMock` reference
 * (via vi.hoisted to dodge the hoisting rule).
 */
import type * as childProcess from "node:child_process";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { tailLogs } from "@/server/docker/real-data";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

beforeEach(() => {
  execFileMock.mockReset();
  process.env.CORTEX_DOCKER_REAL = "1";
});

describe("tailLogs — stderr merge (MP-009)", () => {
  it("returns lines from BOTH stdout and stderr", async () => {
    // `tailLogs` first calls `getContainerById`, which under REAL mode
    // shells out to `docker ps -a --format json` to populate the in-process
    // cache. The second execFile call is the actual `docker logs`. We
    // model both calls.
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: readonly string[] | undefined,
        _options: unknown,
        cb?: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => {
        const args = _args ?? [];
        const isPs = args[0] === "ps" && args[1] === "-a";
        const isLogs = args[0] === "logs";
        let stdout = "";
        if (isPs) {
          stdout = JSON.stringify({
            ID: "a".repeat(64),
            Names: "fake-1",
            Image: "fake:latest",
            State: "running",
            Status: "Up",
            Ports: "",
            CreatedAt: "2026-06-10T00:00:00Z",
            Networks: "bridge",
            Mounts: "",
          });
        } else if (isLogs) {
          stdout = "stdout-line-1\nstdout-line-2\n";
        }
        const stderr = isLogs ? "stderr-line-1\nstderr-line-2\n" : "";
        const result = { stdout, stderr };
        if (typeof cb === "function") {
          cb(null, result);
          return undefined as never;
        }
        return Promise.resolve(result) as never;
      },
    );

    const lines = await tailLogs("a".repeat(64), 50);
    // Both streams merged: must contain stdout lines AND stderr lines.
    expect(lines).toContain("stdout-line-1");
    expect(lines).toContain("stdout-line-2");
    expect(lines).toContain("stderr-line-1");
    expect(lines).toContain("stderr-line-2");
  });
});
