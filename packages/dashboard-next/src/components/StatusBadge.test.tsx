import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UIProvider } from "@/hooks/ui-provider";
import { StatusBadge } from "./StatusBadge";

const wrap = (ui: React.ReactNode) => render(<UIProvider>{ui}</UIProvider>);

describe("StatusBadge", () => {
  it("renders online label", () => {
    wrap(<StatusBadge status="online" />);
    expect(screen.getByText(/Online/i)).toBeInTheDocument();
  });

  it("renders response time when online", () => {
    wrap(<StatusBadge status="online" responseTime={42} />);
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it("hides label in compact mode", () => {
    wrap(<StatusBadge status="offline" compact />);
    expect(screen.queryByText(/Offline/i)).not.toBeInTheDocument();
  });

  it("renders unknown status", () => {
    wrap(<StatusBadge status="unknown" />);
    expect(screen.getByText(/Unknown/i)).toBeInTheDocument();
  });
});
