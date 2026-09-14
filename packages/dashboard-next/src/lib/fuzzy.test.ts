import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns 1 for empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
  });
  it("scores exact substring matches highest", () => {
    expect(fuzzyScore("docker", "docker")).toBeGreaterThan(100);
  });
  it("scores subsequence matches", () => {
    expect(fuzzyScore("dkr", "docker")).toBeGreaterThan(0);
  });
  it("returns 0 when characters are missing", () => {
    expect(fuzzyScore("zzz", "docker")).toBe(0);
  });
  it("is case-insensitive", () => {
    expect(fuzzyScore("DOCKER", "docker")).toBeGreaterThan(0);
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { name: "docker" },
    { name: "incus" },
    { name: "systemd" },
    { name: "deployments" },
  ];
  const key = (i: { name: string }) => i.name;

  it("returns all items for empty query", () => {
    expect(fuzzyFilter(items, "", key)).toEqual(items);
    expect(fuzzyFilter(items, "   ", key)).toEqual(items);
  });
  it("filters out non-matches", () => {
    const out = fuzzyFilter(items, "doc", key);
    expect(out.map((i) => i.name)).toContain("docker");
    expect(out.map((i) => i.name)).not.toContain("incus");
  });
  it("ranks exact substring matches first", () => {
    const out = fuzzyFilter(items, "docker", key);
    expect(out[0].name).toBe("docker");
  });
});
