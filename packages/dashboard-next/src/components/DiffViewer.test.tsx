import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffViewer } from "./DiffViewer";

describe("DiffViewer", () => {
  it("renders unchanged lines once per side", () => {
    render(<DiffViewer before={"a\nb\nc"} after={"a\nb\nc"} />);
    // Each line appears in both panes; just assert one.
    expect(screen.getAllByText(/a/).length).toBeGreaterThanOrEqual(2);
  });

  it("flags added and removed lines", () => {
    render(<DiffViewer before={"a\nb"} after={"a\nB"} />);
    const dels = screen.getAllByText(/- b/);
    const adds = screen.getAllByText(/\+ B/);
    expect(dels.length).toBe(1);
    expect(adds.length).toBe(1);
  });

  it("uses custom labels", () => {
    render(<DiffViewer before="x" after="y" labels={{ before: "Old", after: "New" }} />);
    expect(screen.getByText("Old")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });
});
