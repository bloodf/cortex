import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLocalStorage } from "./useLocalStorage";

describe("useLocalStorage", () => {
  it("returns the initial value when storage is empty", () => {
    const { result } = renderHook(() => useLocalStorage("k1", { count: 0 }));
    expect(result.current[0]).toEqual({ count: 0 });
  });

  it("rehydrates from existing storage on mount", () => {
    localStorage.setItem("k2", JSON.stringify({ count: 42 }));
    const { result } = renderHook(() => useLocalStorage("k2", { count: 0 }));
    expect(result.current[0]).toEqual({ count: 42 });
  });

  it("persists writes to localStorage", () => {
    const { result } = renderHook(() => useLocalStorage("k3", 0));
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
    expect(JSON.parse(localStorage.getItem("k3")!)).toBe(5);
  });

  it("supports functional updates", () => {
    const { result } = renderHook(() => useLocalStorage("k4", 1));
    act(() => result.current[1]((p) => p + 1));
    act(() => result.current[1]((p) => p + 1));
    expect(result.current[0]).toBe(3);
  });

  it("ignores corrupt stored values", () => {
    localStorage.setItem("k5", "{not-json");
    const { result } = renderHook(() => useLocalStorage("k5", "fallback"));
    expect(result.current[0]).toBe("fallback");
  });
});
