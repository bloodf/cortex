import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  Outlet,
  RouterProvider,
  createRouter,
} from "@tanstack/react-router";
import { ThemeProvider as LobeThemeProvider } from "@lobehub/ui";
import { UIProvider } from "@/hooks/ui-provider";
import IncusPage from "@/features/Incus";
import { api } from "@/lib/api/client";
import type { IncusInstance } from "@/mocks/types";

vi.mock("@/lib/api/client", () => ({
  api: {
    incus: vi.fn(),
    incusList: vi.fn(),
  },
  callIncusAction: vi.fn(),
  callMintApproval: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "admin", is_admin: true } }),
}));

function makeInstance(partial: Partial<IncusInstance> = {}): IncusInstance {
  return {
    name: "canary",
    slug: "canary",
    status: "active",
    type: "container",
    image: "ubuntu/24.04",
    cpu: 2,
    memory: 4096,
    config: {},
    devices: {},
    last_validation: null,
    created_at: "2026-06-11T20:00:00.000Z",
    project: {
      name: "Canary",
      description: "test project",
      repo_url: "",
      branch: "main",
    },
    ...partial,
  };
}

async function renderIncus(initialEntry = "/incus") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <UIProvider>
          <LobeThemeProvider themeMode="light">
            <Outlet />
          </LobeThemeProvider>
        </UIProvider>
      </QueryClientProvider>
    ),
  });

  const incusRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "incus",
    component: IncusPage,
  });

  const routeTree = rootRoute.addChildren([incusRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();

  return render(<RouterProvider router={router} />);
}

describe("IncusPage null adapter cells (MP-027)", () => {
  beforeEach(() => {
    vi.mocked(api.incus).mockResolvedValue([]);
    vi.mocked(api.incusList).mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 25 });
  });

  it("renders '—' for null cpu and memory", async () => {
    const row = makeInstance({ cpu: null, memory: null });
    vi.mocked(api.incus).mockResolvedValue([row]);
    vi.mocked(api.incusList).mockResolvedValue({ rows: [row], total: 1, page: 0, pageSize: 25 });

    await renderIncus();

    await waitFor(
      () => {
        const cells = screen.getAllByText("—");
        expect(cells.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 },
    );
  });
});
