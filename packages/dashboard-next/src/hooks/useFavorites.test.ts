import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFavorites } from "./useFavorites";

describe("useFavorites", () => {
  it("toggles a slug on and off", () => {
    localStorage.clear();
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite("x")).toBe(false);
    act(() => result.current.toggle("x"));
    expect(result.current.isFavorite("x")).toBe(true);
    act(() => result.current.toggle("x"));
    expect(result.current.isFavorite("x")).toBe(false);
  });
});
