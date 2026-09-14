import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionProvider, ThemeProvider as LobeThemeProvider } from "@lobehub/ui";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";

/**
 * PromptInputButton now uses the lobe Tooltip (title prop), which manages its
 * own positioning and needs no TooltipProvider — the old Radix
 * "Tooltip must be used within TooltipProvider" contract is gone. Lobe
 * tooltips portal through the lobe ThemeProvider, so the hover assertion
 * runs inside the same provider stack the app root supplies (see
 * src/routes/__root.tsx).
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <LobeThemeProvider themeMode="light">
      <MotionProvider motion={motion}>{children}</MotionProvider>
    </LobeThemeProvider>
  );
}

describe("PromptInputButton tooltip (lobe)", () => {
  it("renders standalone without any provider", () => {
    const { getByText } = render(<PromptInputButton tooltip="Attach files">x</PromptInputButton>);
    expect(getByText("x")).toBeTruthy();
  });

  it("shows the tooltip content on hover", async () => {
    const user = userEvent.setup();
    const { getByRole, findByText } = render(
      <Providers>
        <PromptInputButton tooltip="Attach files">x</PromptInputButton>
      </Providers>,
    );
    await user.hover(getByRole("button"));
    expect(await findByText("Attach files")).toBeTruthy();
  });
});
