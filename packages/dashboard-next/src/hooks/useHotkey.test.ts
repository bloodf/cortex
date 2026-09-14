import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHotkey } from "./useHotkey";

describe("useHotkey", () => {
  it("fires callback when matcher returns true", () => {
    const cb = vi.fn();
    renderHook(() => useHotkey((e) => e.key === "k", cb));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire when matcher returns false", () => {
    const cb = vi.fn();
    renderHook(() => useHotkey((e) => e.key === "k", cb));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(cb).not.toHaveBeenCalled();
  });

  it("removes listener on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useHotkey((e) => e.key === "k", cb));
    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    expect(cb).not.toHaveBeenCalled();
  });
});
