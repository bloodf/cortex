// @vitest-environment node
/**
 * Mintable-action allowlist (approval-mint-unrestricted-action-string).
 *
 * `mintApproval` must refuse to mint an approval token for an action string
 * no real gate uses. This stops a compromised self-mint path (e.g. the
 * systemd/docker/incus bridges that re-use `mintApproval`) from forging
 * approval for an arbitrary action and defeating that bridge's own
 * destructive-action gate. Confirmation-only defence-in-depth.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isMintableAction,
  mintApproval,
  registerMintableAction,
  resetApprovalStore,
  UnmintableActionError,
} from "..";
import { asSessionId } from "../../entities";

const baseInput = {
  payload: { name: "demo" },
  sessionId: asSessionId("sess-1"),
  userId: "u-1",
  ttlSec: 60,
};

beforeEach(() => {
  resetApprovalStore();
});

afterEach(() => {
  resetApprovalStore();
});

describe("mintApproval — mintable-action allowlist", () => {
  it.each([
    "systemd.action",
    "systemd.restart",
    "systemd.stop",
    "agents.action",
    "agents.model",
    "incus.action",
    "incus.delete",
    "docker.action",
    "docker.prune",
    "docker.stop",
    "start", // agent control verb
    "reveal.DB_PASSWORD", // reveal grant (prefix-allowed)
  ])("mints an allowlisted action: %s", (action) => {
    const tok = mintApproval({ ...baseInput, action });
    expect(tok.token).toMatch(/^v1\./);
    expect(isMintableAction(action)).toBe(true);
  });

  it.each([
    "arbitrary.action",
    "system.shutdown",
    "rm -rf /",
    "../../etc/passwd",
    "docker.exec", // privileged op deliberately NOT mintable here
    "",
  ])("rejects an unknown/arbitrary action: %s", (action) => {
    expect(isMintableAction(action)).toBe(false);
    expect(() => mintApproval({ ...baseInput, action })).toThrow(UnmintableActionError);
  });

  it("a registered synthetic action becomes mintable", () => {
    const action = "system.probe.synthetic";
    expect(isMintableAction(action)).toBe(false);
    registerMintableAction(action);
    expect(isMintableAction(action)).toBe(true);
    expect(() => mintApproval({ ...baseInput, action })).not.toThrow();
  });
});
