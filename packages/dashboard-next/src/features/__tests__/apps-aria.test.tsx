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
import { UIProvider } from "@/hooks/ui-provider";
import AppsPage from "@/features/Apps";
import { api } from "@/lib/api/client";
import type { Service } from "@/mocks/types";

vi.mock("@/lib/api/client", () => ({
  api: {
    services: vi.fn(),
  },
}));

const svc: Service = {
  id: 1,
  slug: "grafana",
  name: "Grafana",
  open_url: "https://grafana.example",
  category: "Observability",
  status: "online",
  responseTime: 42,
  icon_color: "#f60",
  icon_image: null,
  kind: "app",
  health_url: "https://grafana.example/health",
  health_type: "http",
  description: "Dashboards",
  env_source: null,
  is_active: true,
  has_webui: true,
  show_in_healthcheck: true,
  show_in_webui: true,
  sort_order: 0,
  icon_type: "tech",
  badges: [],
};

function renderApps() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <UIProvider>
          <Outlet />
        </UIProvider>
      </QueryClientProvider>
    ),
  });
  const appsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "apps",
    component: AppsPage,
  });
  const routeTree = rootRoute.addChildren([appsRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/apps"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("AppsPage icon controls expose accessible names", () => {
  beforeEach(() => {
    vi.mocked(api.services).mockResolvedValue([svc]);
  });

  it("the favorite-toggle button has an accessible name reflecting state", async () => {
    renderApps();
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: "Add Grafana to favorites" }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  it("the open-service link has an accessible name", async () => {
    renderApps();
    await waitFor(
      () => {
        expect(screen.getByRole("link", { name: "Open Grafana" })).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });
});
