import { describe, expect, it } from "vitest";
import { NAV } from "../NavConfig";

describe("central navigation", () => {
  it("includes the MCP servers page with its Plug icon", () => {
    const item = NAV.flatMap((group) => group.items).find(({ to }) => to === "/mcps");

    expect(item?.key).toBe("mcps");
    expect(item?.icon.displayName).toBe("Plug");
  });
});
