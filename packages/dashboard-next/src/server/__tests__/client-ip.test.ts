// @vitest-environment node
/**
 * readClientIp must use ONLY the Caddy-controlled `X-Real-IP` header and must
 * NOT trust client-supplied `X-Forwarded-For`. Regression guard for the login
 * rate-limit bypass (login-ratelimit-bypass-via-spoofed-xff): an attacker who
 * rotates X-Forwarded-For must not get a fresh rate-limit bucket.
 */
import { describe, it, expect } from "vitest";
import { readClientIp } from "../context";

function req(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:3080/login", { headers });
}

describe("readClientIp — trusted-proxy IP resolution", () => {
  it("uses X-Real-IP (set by Caddy {client_ip})", () => {
    expect(readClientIp(req({ "x-real-ip": "192.0.2.59" }))).toBe("192.0.2.59");
  });

  it("IGNORES a spoofed X-Forwarded-For — the brute-force bypass", () => {
    // Attacker rotates XFF to mint fresh buckets; X-Real-IP is the real client.
    expect(
      readClientIp(req({ "x-forwarded-for": "198.51.100.6, 203.0.113.9", "x-real-ip": "192.0.2.59" })),
    ).toBe("192.0.2.59");
  });

  it("does NOT fall through to X-Forwarded-For when X-Real-IP is absent", () => {
    // Fail closed to loopback (one shared bucket), never to the spoofable value.
    expect(readClientIp(req({ "x-forwarded-for": "198.51.100.6" }))).toBe("127.0.0.1");
  });

  it("falls back to loopback when no forwarding header is present", () => {
    expect(readClientIp(req({}))).toBe("127.0.0.1");
  });

  it("trims surrounding whitespace on X-Real-IP", () => {
    expect(readClientIp(req({ "x-real-ip": "  192.0.2.4  " }))).toBe("192.0.2.4");
  });
});
