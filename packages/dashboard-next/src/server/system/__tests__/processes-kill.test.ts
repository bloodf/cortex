// @vitest-environment node
import { describe, it, expect } from "vitest";
import { killProcess } from "@/server/system/processes";

describe("killProcess guards", () => {
  it("refuses PID <= 1 (init / invalid)", () => {
    expect(() => killProcess(1, "SIGTERM")).toThrow(/Refusing to signal PID 1/);
    expect(() => killProcess(0, "SIGTERM")).toThrow(/Refusing to signal PID 0/);
    expect(() => killProcess(-5, "SIGTERM")).toThrow(/Refusing to signal PID -5/);
  });

  it("refuses non-integer PIDs", () => {
    expect(() => killProcess(3.5, "SIGTERM")).toThrow(/Refusing to signal/);
  });

  it("refuses signalling the dashboard's own process", () => {
    expect(() => killProcess(process.pid, "SIGKILL")).toThrow(/dashboard process itself/);
  });
});
