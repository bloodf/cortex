import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DependenciesPage from "@/features/Dependencies";
import { api } from "@/lib/api/client";
import type { DependenciesPayload, ServiceNodeInfo } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  api: {
    dependencies: { list: vi.fn() },
  },
  callScanDependenciesNow: vi.fn(),
  callSetDependencyEdge: vi.fn(),
  callRemoveDependencyEdge: vi.fn(),
  callMintApproval: vi.fn(),
  callSetServiceAutostart: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "admin", is_admin: true } }),
}));

// jsdom lacks DOMMatrix/DOMPoint, which @xyflow/react touches during render.
beforeAll(() => {
  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    class FakeDOMMatrixReadOnly {
      m22 = 1;
      constructor(init?: string | number[]) {
        const source = init ?? [];
        if (typeof source !== "string") {
          this.m22 = source[10] ?? 1;
        }
      }
      translate() {
        return { m22: this.m22 };
      }
      scaleNonUniform() {
        return { m22: this.m22 };
      }
    }
    class FakeDOMPoint {
      x: number;
      y: number;
      constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
      }
      matrixTransform() {
        return this;
      }
    }
    vi.stubGlobal("DOMMatrixReadOnly", FakeDOMMatrixReadOnly);
    vi.stubGlobal("DOMMatrix", FakeDOMMatrixReadOnly);
    vi.stubGlobal("DOMPoint", FakeDOMPoint);
  }
});

function makeNode(
  partial: Partial<ServiceNodeInfo> & { slug: string; name: string },
): ServiceNodeInfo {
  return {
    id: 1,
    kind: "service",
    category: "ai",
    description: null,
    healthUrl: "#",
    healthType: "http",
    openUrl: "#",
    envSource: null,
    status: "unknown",
    lastCheckAt: null,
    responseMs: null,
    uptime24h: null,
    sortOrder: 0,
    isActive: true,
    hasWebui: true,
    showInHealthcheck: true,
    showInWebui: true,
    autostart: true,
    unitName: null,
    containerNames: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    icon: { type: "auto", color: null, image: null },
    badges: [],
    running: false,
    memBytes: null,
    cpuPct: null,
    dependents: [],
    ...partial,
  };
}

const PAYLOAD: DependenciesPayload = {
  nodes: [
    makeNode({
      slug: "durindoor",
      name: "DurinDoor",
      unitName: "durindoor.service",
      running: true,
      memBytes: 256 * 1024 * 1024,
      cpuPct: 1.5,
      dependents: ["hermes-main"],
    }),
    makeNode({
      slug: "hermes-main",
      name: "Hermes Main",
      unitName: "hermes-main.service",
      running: true,
    }),
    makeNode({
      slug: "lonely",
      name: "Lonely Service",
      category: "misc",
      autostart: false,
      containerNames: ["lonely"],
    }),
  ],
  edges: [
    {
      id: 1,
      sourceSlug: "hermes-main",
      targetSlug: "durindoor",
      kind: "configured",
      source: "seed",
      detail: "OPENAI_BASE_URL",
      lastSeenAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ],
};

/** Walk up from a label to the dimmable node card div (not the xyflow wrapper). */
function cardOf(text: string): HTMLElement {
  const el = screen.getByText(text).closest(".transition-opacity");
  if (!(el instanceof HTMLElement)) throw new Error(`node card not found for ${text}`);
  return el;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DependenciesPage />
    </QueryClientProvider>,
  );
}

describe("DependenciesPage", () => {
  beforeEach(() => {
    vi.mocked(api.dependencies.list).mockResolvedValue(PAYLOAD);
  });

  it("renders node cards and the legend disclaimer", async () => {
    renderPage();

    expect(await screen.findByText("DurinDoor")).toBeInTheDocument();
    expect(screen.getByText("Hermes Main")).toBeInTheDocument();
    expect(screen.getByText("Lonely Service")).toBeInTheDocument();
    expect(
      screen.getByText(/No edge ≠ unused — configured edges come from static config/),
    ).toBeInTheDocument();
  });

  it("orphans filter highlights (dims) connected nodes without removing them", async () => {
    renderPage();
    await screen.findByText("DurinDoor");

    const orphansBtn = screen.getByRole("button", { name: /Unreferenced/ });
    await userEvent.click(orphansBtn);

    await waitFor(() => {
      // Connected nodes dimmed, orphan untouched, all still rendered.
      expect(cardOf("DurinDoor").className).toContain("opacity-35");
      expect(cardOf("Hermes Main").className).toContain("opacity-35");
      expect(cardOf("Lonely Service").className).not.toContain("opacity-35");
    });
  });

  it("clicking a node sets focus highlight on the canvas", async () => {
    const { container } = renderPage();
    await screen.findByText("DurinDoor");

    // No focus initially.
    expect(container.querySelector("[data-focus-slug]")).toBeNull();

    fireEvent.click(screen.getByText("DurinDoor"));

    await waitFor(() => {
      const canvas = container.querySelector("[data-focus-slug]");
      expect(canvas).not.toBeNull();
      expect(canvas?.getAttribute("data-focus-slug")).toBe("durindoor");
    });
  });
});
