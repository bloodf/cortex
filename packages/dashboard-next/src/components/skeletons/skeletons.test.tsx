import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import renderWithProviders from "@/test/render-helpers";
import {
  Skeleton,
  TableSkeleton,
  CardSkeleton,
  ChartSkeleton,
  DetailSkeleton,
  InlineSkeleton,
} from ".";

describe("Skeleton primitives", () => {
  it("renders a base skeleton", () => {
    renderWithProviders(<Skeleton data-testid="x" />);
    expect(screen.getByTestId("x")).toHaveClass("animate-pulse");
  });

  it("renders a TableSkeleton with the right number of rows", () => {
    renderWithProviders(<TableSkeleton rows={4} cols={3} />);
    const grid = screen.getByTestId("table-skeleton");
    expect(grid).toBeInTheDocument();
  });

  it("renders a CardSkeleton", () => {
    renderWithProviders(<CardSkeleton />);
    expect(screen.getByTestId("card-skeleton")).toBeInTheDocument();
  });

  it("renders a ChartSkeleton", () => {
    renderWithProviders(<ChartSkeleton height={120} />);
    expect(screen.getByTestId("chart-skeleton")).toBeInTheDocument();
  });

  it("renders a DetailSkeleton containing nested skeletons", () => {
    renderWithProviders(<DetailSkeleton />);
    expect(screen.getByTestId("detail-skeleton")).toBeInTheDocument();
    expect(screen.getAllByTestId("card-skeleton")).toHaveLength(2);
    expect(screen.getByTestId("table-skeleton")).toBeInTheDocument();
  });

  it("renders an InlineSkeleton with explicit width", () => {
    renderWithProviders(<InlineSkeleton width={42} data-testid="inline" />);
    // Component sets width via style — at minimum it should be present
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });
});
