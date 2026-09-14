import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeInTheDocument();
  });

  it("renders optional description, icon, and action", () => {
    render(
      <EmptyState
        title="Empty"
        description="Try refreshing"
        icon={<span data-testid="icon">i</span>}
        action={<button>Refresh</button>}
      />,
    );
    expect(screen.getByText("Try refreshing")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
