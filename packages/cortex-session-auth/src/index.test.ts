// @vitest-environment node
/**
 * cortex-session-auth — unit tests for the pure helpers.
 *
 * Mirrors the terminal sidecar's auth contract:
 *   - parseCookies: defensive decode, never throws on malformed %-escape
 *   - checkOrigin: same-origin mode requires host match; concrete origin exact
 *   - deriveSessionGrant: row → grant only when user active, role fresh, isAdmin
 */

import { describe, it, expect } from "vitest";
import {
  parseCookies,
  checkOrigin,
  deriveSessionGrant,
  type SessionRow,
} from "@cortexos/session-auth";

describe("parseCookies", () => {
  it("returns empty for missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });
  it("parses simple pairs", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });
  it("decodes percent-escapes", () => {
    expect(parseCookies("x=hello%20world")).toEqual({ x: "hello world" });
  });
  it("keeps raw value on malformed %-escape (does not throw)", () => {
    const out = parseCookies("x=%ZZ");
    expect(out.x).toBe("%ZZ");
  });
  it("ignores parts without '='", () => {
    expect(parseCookies("junk; k=v")).toEqual({ k: "v" });
  });
});

describe("checkOrigin", () => {
  it("rejects missing origin in same-origin mode (unset allowedOrigin)", () => {
    expect(checkOrigin(undefined, "host:8443", undefined)).toBe(false);
  });
  it("accepts matching host in same-origin mode (unset allowedOrigin)", () => {
    expect(checkOrigin("https://host:8443", "host:8443", undefined)).toBe(true);
  });
  it("rejects host mismatch in same-origin mode", () => {
    expect(checkOrigin("https://evil:8443", "host:8443", undefined)).toBe(false);
  });
  it("rejects unparseable origin in same-origin mode", () => {
    expect(checkOrigin("not a url", "host:8443", undefined)).toBe(false);
  });
  it("requires exact origin match when allowedOrigin is concrete", () => {
    expect(checkOrigin("https://allowed.example", "host:443", "https://allowed.example")).toBe(true);
    expect(checkOrigin("https://other.example", "host:443", "https://allowed.example")).toBe(false);
    expect(checkOrigin(undefined, "host:443", "https://allowed.example")).toBe(false);
  });
});

describe("deriveSessionGrant", () => {
  const now = 1_700_000_000_000;
  const freshRow: SessionRow = { username: "alice", last_role_check_at: now - 30_000 };
  const staleRow: SessionRow = { username: "alice", last_role_check_at: now - 200_000 };
  const baseDeps = { userActive: () => true, isAdmin: () => true, now: () => now };

  it("returns null for null row", () => {
    expect(deriveSessionGrant(null, baseDeps)).toBeNull();
  });
  it("returns null for empty username", () => {
    expect(deriveSessionGrant({ username: "", last_role_check_at: now }, baseDeps)).toBeNull();
  });
  it("returns null when account is inactive", () => {
    expect(deriveSessionGrant(freshRow, { ...baseDeps, userActive: () => false })).toBeNull();
  });
  it("returns null when role check is stale", () => {
    expect(deriveSessionGrant(staleRow, baseDeps)).toBeNull();
  });
  it("returns null for missing last_role_check_at", () => {
    expect(deriveSessionGrant({ username: "alice", last_role_check_at: null }, baseDeps)).toBeNull();
  });
  it("returns non-admin when isAdmin probe says false", () => {
    expect(deriveSessionGrant(freshRow, { ...baseDeps, isAdmin: () => false })).toEqual({
      username: "alice",
      isAdmin: false,
    });
  });
  it("grants admin when all checks pass", () => {
    expect(deriveSessionGrant(freshRow, baseDeps)).toEqual({ username: "alice", isAdmin: true });
  });
  it("accepts last_role_check_at as Date", () => {
    expect(deriveSessionGrant({ ...freshRow, last_role_check_at: new Date(now - 10_000) }, baseDeps)).toEqual({
      username: "alice",
      isAdmin: true,
    });
  });
  it("respects custom maxRoleAgeMs", () => {
    expect(deriveSessionGrant(freshRow, { ...baseDeps, maxRoleAgeMs: 10_000 })).toBeNull();
  });
});
