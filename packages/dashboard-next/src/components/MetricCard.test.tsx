import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricCard } from "./MetricCard";

describe("MetricCard", () => {
  it("renders label and value", () => {
    render(<MetricCard label="CPU" value="42%" />);
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("renders hint and trend slots", () => {
    render(
      <MetricCard
        label="Mem"
        value="1.2 GB"
        hint="of 8 GB"
        trend={<span data-testid="trend">spark</span>}
      />,
    );
    expect(screen.getByText("of 8 GB")).toBeInTheDocument();
    expect(screen.getByTestId("trend")).toBeInTheDocument();
  });
});
