import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { UIProvider } from "./ui-provider";
import { useT } from "./useT";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UIProvider>{children}</UIProvider>
);

describe("useT", () => {
  it("returns the English dictionary", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    expect(result.current.common.save).toBe("Save");
    expect(result.current.auth.signIn).toBe("Sign in");
  });
});
