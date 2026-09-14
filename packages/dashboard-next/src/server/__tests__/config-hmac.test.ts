// @vitest-environment node
/**
 * Approval-signing HMAC key derivation (hmac-key-random-per-process-not-from-secret).
 *
 * In production the key MUST be derived deterministically from
 * `CORTEX_MASTER_KEY` so approval tokens survive process restarts / multiple
 * workers. Production with a missing/short secret must FAIL CLOSED; dev/test
 * keeps a random per-process fallback so it still runs.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerHmacKey, loadServerHmacKeyFromEnv, setServerHmacKey } from "../config";

const SECRET = "a-sufficiently-long-master-key-0123456789";

let savedKey: string | undefined;
let savedEnv: string | undefined;

beforeEach(() => {
  savedKey = process.env.CORTEX_MASTER_KEY;
  savedEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.CORTEX_MASTER_KEY;
  else process.env.CORTEX_MASTER_KEY = savedKey;
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
});

describe("loadServerHmacKeyFromEnv", () => {
  it("derives a stable 32-byte key as sha256(CORTEX_MASTER_KEY)", () => {
    process.env.CORTEX_MASTER_KEY = SECRET;
    process.env.NODE_ENV = "production";
    loadServerHmacKeyFromEnv();
    const k1 = getServerHmacKey();
    expect(k1.length).toBe(32);
    expect(k1.equals(createHash("sha256").update(SECRET, "utf8").digest())).toBe(true);
  });

  it("is deterministic — two loads with the same secret match", () => {
    process.env.CORTEX_MASTER_KEY = SECRET;
    process.env.NODE_ENV = "production";
    loadServerHmacKeyFromEnv();
    const a = Buffer.from(getServerHmacKey());
    // Clobber, then reload the same secret.
    setServerHmacKey(Buffer.alloc(32, 7));
    loadServerHmacKeyFromEnv();
    const b = getServerHmacKey();
    expect(a.equals(b)).toBe(true);
  });

  it("FAILS CLOSED in production when the secret is missing", () => {
    delete process.env.CORTEX_MASTER_KEY;
    process.env.NODE_ENV = "production";
    expect(() => loadServerHmacKeyFromEnv()).toThrow(/CORTEX_MASTER_KEY/);
  });

  it("FAILS CLOSED in production when the secret is too short", () => {
    process.env.CORTEX_MASTER_KEY = "short";
    process.env.NODE_ENV = "production";
    expect(() => loadServerHmacKeyFromEnv()).toThrow(/too short|missing/);
  });

  it("falls back without throwing in dev/test when the secret is absent", () => {
    delete process.env.CORTEX_MASTER_KEY;
    process.env.NODE_ENV = "test";
    const before = Buffer.from(getServerHmacKey());
    expect(() => loadServerHmacKeyFromEnv()).not.toThrow();
    // Random fallback is left in place (key unchanged by the no-op load).
    expect(getServerHmacKey().equals(before)).toBe(true);
  });
});
