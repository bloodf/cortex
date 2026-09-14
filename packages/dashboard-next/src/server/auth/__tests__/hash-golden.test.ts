// @vitest-environment node
/**
 * MP-020e golden tests — prove hash rewrites are bit-identical.
 * Run against CURRENT implementation BEFORE and AFTER the no-bitwise rewrite.
 */
import { describe, it, expect } from "vitest";
import { fakeHash } from "@/lib/constants";
import { safeCsrfEqual } from "@/server/auth/cookies";

describe("fakeHash golden outputs", () => {
  const cases: [string, string, string][] = [
    ["", "", "0002b621…"],
    ["genesis…", "test", "684ae0f5…"],
    ["a", "b", "0b885fe4…"],
    ["hello", "world", "0bec629d…"],
    ["unicode:🚀", "test", "9589b17f…"],
    [`long-${"x".repeat(1000)}`, "payload", "89754428…"],
    ["prev", "unicode:日本語", "9e11238e…"],
    ["0".repeat(64), "1".repeat(64), "d309fa61…"],
  ];

  it.each(cases)("fakeHash(%p, %p) === %p", (prev, payload, expected) => {
    expect(fakeHash(prev, payload)).toBe(expected);
  });
});

describe("safeCsrfEqual golden outputs", () => {
  const t = "a".repeat(43);
  const u = "b".repeat(43);

  const cases: [string | null, string | null, boolean][] = [
    ["abc", "abc", true],
    ["abc", "abd", false],
    [null, "abc", false],
    ["abc", null, false],
    ["", "", true],
    [t, t, true],
    [t, u, false],
    ["\u0000\u0001", "\u0000\u0001", true],
    ["\u0000\u0001", "\u0000\u0002", false],
    ["same", "same", true],
    ["same", "diff", false],
  ];

  it.each(cases)("safeCsrfEqual(%p, %p) === %p", (a, b, expected) => {
    expect(safeCsrfEqual(a, b)).toBe(expected);
  });
});
