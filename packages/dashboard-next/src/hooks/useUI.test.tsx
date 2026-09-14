import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { UIProvider } from "./ui-provider";
import { useUI } from "./useUI";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UIProvider>{children}</UIProvider>
);

describe("useUI", () => {
  it("provides default values", () => {
    const { result } = renderHook(() => useUI(), { wrapper });
    expect(result.current.theme).toBe("dark");
    expect(result.current.accent).toBe("cortex");
  });

  it("updates theme and persists", () => {
    localStorage.clear();
    const { result } = renderHook(() => useUI(), { wrapper });
    act(() => result.current.setTheme("light"));
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("cortex.theme")).toBe("light");
  });

  it("updates accent", () => {
    const { result } = renderHook(() => useUI(), { wrapper });
    act(() => result.current.setAccent("cyan"));
    expect(result.current.accent).toBe("cyan");
  });

  it("throws when used outside provider", () => {
    expect(() => renderHook(() => useUI())).toThrow();
  });
});
