import { describe, it, expect } from "vitest";
import { isContainerActionPending } from "@/features/Docker";

// Regression (Phase 1 bug audit): pendingAction is keyed `${op}-${id}`
// (e.g. "start-abc123"). The old code used `pendingAction.startsWith(id)`,
// which is ALWAYS false (the key starts with the op, not the id), so action
// buttons never disabled during an in-flight op. Match the `-${id}` suffix.
describe("isContainerActionPending", () => {
  const id = "abc123";

  it("is true while an action is pending for this container", () => {
    expect(isContainerActionPending(`start-${id}`, id)).toBe(true);
    expect(isContainerActionPending(`stop-${id}`, id)).toBe(true);
    expect(isContainerActionPending(`restart-${id}`, id)).toBe(true);
  });

  it("is false when nothing is pending", () => {
    expect(isContainerActionPending(null, id)).toBe(false);
  });

  it("is false for a different container", () => {
    expect(isContainerActionPending("start-other", id)).toBe(false);
  });

  it("does not match a bare id prefix (the original bug)", () => {
    // Old buggy check `startsWith(id)` would be false here too, but the key
    // never starts with the id — this asserts we key on the op-prefixed form.
    expect(isContainerActionPending(id, id)).toBe(false);
    expect(isContainerActionPending(`start-x${id}`, id)).toBe(false);
  });
});
