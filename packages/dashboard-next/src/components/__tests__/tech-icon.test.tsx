import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TechIcon } from "@/components/TechIcon";

describe("TechIcon resolution chain", () => {
  it("renders the explicit iconImage URL first when provided", () => {
    render(<TechIcon slug="durindoor" name="DurinDoor" iconImage="/uploads/d.png" size={24} />);
    const img = screen.getByRole("img", { name: "DurinDoor" });
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "/uploads/d.png");
  });

  it("renders a lobe brand icon (svg, not img) for mapped slugs", () => {
    const { container } = render(<TechIcon slug="lobe-chat" name="LobeChat" size={24} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders unknown private identifiers locally without a remote image request", () => {
    const { container } = render(<TechIcon slug="private-container-identifier" name="Private app" size={24} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "Private app" })).toHaveTextContent("PR");
  });

  it("does not treat a scheme-relative remote URL as a local custom image", () => {
    const { container } = render(
      <TechIcon slug="private" name="Private app" iconImage="//third-party.invalid/private" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "Private app" })).toHaveTextContent("PR");
  });

  it("iconImage error falls through to the bundled brand icon", () => {
    const { container } = render(
      <TechIcon slug="durindoor" name="DurinDoor" iconImage="/uploads/broken.png" />,
    );
    fireEvent.error(screen.getByRole("img", { name: "DurinDoor" }));
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders a local monogram when an explicit image fails for an unknown slug", () => {
    render(<TechIcon slug="zzz" name="Zeta" iconImage="/uploads/none.png" />);
    fireEvent.error(screen.getByRole("img", { name: "Zeta" }));
    expect(screen.getByRole("img", { name: "Zeta" })).toHaveTextContent("ZE");
  });
});
