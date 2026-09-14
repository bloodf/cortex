// @vitest-environment node
/**
 * C1 regression: incus destructive action approval-payload contract.
 *
 * The bridge hashes `actionHashFor('incus.' + action, { name })`. The UI
 * MUST mint against exactly that shape (note `payload: { name }` — no
 * `action` key, since that would change the hash and fail-close every
 * UI-driven destructive action). See src/server/incus/bridge.ts:1196,1474
 * for the consumer side.
 */

import { describe, it, expect } from "vitest";
import { mintApproval, actionHashFor } from "@/server/approval";

describe("incus action approval mint contract (C1)", () => {
  it("accepts mint with `{ name }` only (matches bridge hash)", () => {
    const action = "incus.stop";
    const payload = { name: "demo-instance" };
    const token = mintApproval({
      action,
      payload,
      sessionId: { id: "s1" } as never,
      userId: "u1",
    });
    expect(token.actionHash).toBe(actionHashFor(action, payload));
    expect(token.token).toMatch(/^v1\./);
  });

  it("rejects mint whose payload includes extraneous keys (different hash)", () => {
    const action = "incus.stop";
    const correctPayload = { name: "demo-instance" };
    const mintedWithExtra = actionHashFor(action, {
      name: "demo-instance",
      action: "stop",
    });
    expect(mintedWithExtra).not.toBe(actionHashFor(action, correctPayload));
  });

  it("treats each incus verb as a distinct policy name (no cross-verb mint)", () => {
    const payload = { name: "demo" };
    const a = actionHashFor("incus.stop", payload);
    const b = actionHashFor("incus.delete", payload);
    expect(a).not.toBe(b);
  });

  it("launch path uses identical `{ name }`-only binding", () => {
    // Incus launch also goes through bridge.ts:1104 (~1200ish), same
    // `actionHashFor('incus.'+action, { name })` contract.
    const payload = { name: "demo-instance" };
    const token = mintApproval({
      action: "incus.launch",
      payload,
      sessionId: { id: "s1" } as never,
      userId: "u1",
    });
    expect(token.actionHash).toBe(actionHashFor("incus.launch", payload));
  });
});
