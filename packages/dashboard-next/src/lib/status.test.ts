import { describe, it, expect } from "vitest";
import { statusColor, tempColor, usageColor, usageBg } from "./status";

describe("statusColor", () => {
  it("returns success tokens for online", () => {
    expect(statusColor("online").dot).toContain("success");
  });
  it("returns destructive tokens for offline", () => {
    expect(statusColor("offline").dot).toContain("destructive");
  });
  it("animates when checking", () => {
    expect(statusColor("checking").dot).toContain("animate-pulse");
  });
  it("falls back to muted for unknown", () => {
    expect(statusColor("unknown").dot).toContain("muted-foreground");
  });
});

describe("tempColor", () => {
  it("destructive when ≥ 85", () => {
    expect(tempColor(85)).toContain("destructive");
    expect(tempColor(95)).toContain("destructive");
  });
  it("warning between 70 and 85", () => {
    expect(tempColor(70)).toContain("warning");
    expect(tempColor(80)).toContain("warning");
  });
  it("success under 70", () => {
    expect(tempColor(50)).toContain("success");
  });
});

describe("usageColor / usageBg", () => {
  it("destructive ≥ 90", () => {
    expect(usageColor(90)).toContain("destructive");
    expect(usageBg(95)).toContain("destructive");
  });
  it("warning ≥ 75 and < 90", () => {
    expect(usageColor(80)).toContain("warning");
    expect(usageBg(75)).toContain("warning");
  });
  it("success under 75", () => {
    expect(usageColor(30)).toContain("success");
    expect(usageBg(0)).toContain("success");
  });
});
