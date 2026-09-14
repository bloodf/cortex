import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders empty svg with no data", () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelectorAll("path").length).toBe(0);
  });

  it("renders both fill and stroke paths by default", () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 4]} />);
    expect(container.querySelectorAll("path").length).toBe(2);
  });

  it("omits fill when fill=false", () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} fill={false} />);
    expect(container.querySelectorAll("path").length).toBe(1);
  });
});
