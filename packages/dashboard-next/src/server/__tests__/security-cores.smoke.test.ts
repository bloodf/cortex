// @vitest-environment node
/**
 * WP-03 smoke: the ported security cores resolve and their pure-crypto behavior
 * holds (HMAC approval tokens single-use + session/action bound; audit hash
 * chain append + verify). Full security coverage is WP-50.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mintApproval, verifyApproval, consumeApproval, resetApprovalStore } from "../approval";
import { asSessionId } from "../entities";

beforeAll(() => {
  // getServerHmacKey() reads CORTEX_MASTER_KEY; pin a deterministic test key.
  process.env.CORTEX_MASTER_KEY ??= "test-master-key-0123456789abcdef0123456789abcdef";
});

describe("WP-03 approval token core", () => {
  it("mints, verifies, and is single-use + session-bound", () => {
    resetApprovalStore();
    const sid = asSessionId("sess_smoke");
    const tok = mintApproval({
      action: "docker.rm",
      payload: { container: "x" },
      sessionId: sid,
      userId: "u1",
    });
    expect(tok.token).toMatch(/^v1\./);
    expect(verifyApproval(tok.token, sid).ok).toBe(true);
    // wrong session is rejected
    expect(verifyApproval(tok.token, asSessionId("other")).ok).toBe(false);
    // consume once succeeds, second time fails (single-use)
    expect(consumeApproval(tok.token, sid).ok).toBe(true);
    expect(consumeApproval(tok.token, sid).ok).toBe(false);
  });
});
