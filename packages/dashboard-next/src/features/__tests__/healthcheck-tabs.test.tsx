import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { HealthcheckPage } from "@/features/Healthcheck";
import { api, callHostLogs } from "@/lib/api/client";
import type { Service, AlertHistory } from "@/mocks/types";

vi.mock("@/lib/api/client", () => ({
  api: {
    healthcheckList: vi.fn(),
    alerts: {
      history: vi.fn(),
    },
  },
  callHostLogs: vi.fn(),
}));

const mockService: Service = {
  id: 1,
  slug: "gateway",
  name: "API Gateway",
  open_url: "https://dashboard.example.com/gateway",
  category: "Core",
  status: "online",
  responseTime: 12,
  icon_color: null,
  icon_image: null,
  kind: "app",
  health_url: "https://dashboard.example.com/gateway/health",
  health_type: "http",
  description: "Core API gateway",
  env_source: null,
  is_active: true,
  has_webui: true,
  show_in_healthcheck: true,
  show_in_webui: true,
  sort_order: 1,
  icon_type: "auto",
  badges: [],
};

const mockHistory: AlertHistory[] = [
  {
    id: "ah-1",
    ruleName: "API latency",
    serviceName: "gateway",
    status: "fired",
    message: "p95 latency exceeded",
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: "ah-2",
    ruleName: "Database connection",
    serviceName: "postgresql",
    status: "resolved",
    message: "connection restored",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
  },
];

function renderHealthcheck(initialEntry = "/healthcheck") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <UIProvider>
          <Outlet />
        </UIProvider>
      </QueryClientProvider>
    ),
  });

  const healthRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "healthcheck",
    component: HealthcheckPage,
  });

  const routeTree = rootRoute.addChildren([healthRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("HealthcheckPage tabs (MP-023)", () => {
  beforeEach(() => {
    vi.mocked(api.healthcheckList).mockResolvedValue({
      rows: [mockService],
      total: 1,
      page: 0,
      pageSize: 25,
    });
    vi.mocked(api.alerts.history).mockResolvedValue(mockHistory);
    vi.mocked(callHostLogs).mockResolvedValue({ lines: [], limit: 200, count: 0 });
  });

  it("renders Health and Logs tabs", async () => {
    renderHealthcheck();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Health" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Logs" })).toBeInTheDocument();
    });
  });

  it("shows the DataTable on Health and the LogStream on Logs", async () => {
    renderHealthcheck();
    await waitFor(() => expect(screen.getByRole("tabpanel")).toBeInTheDocument());

    const healthPanel = screen.getByRole("tabpanel");
    expect(within(healthPanel).getByText("Service")).toBeInTheDocument();
    expect(within(healthPanel).getByText("Incident timeline")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
      const logsPanel = screen.getByRole("tabpanel");
      expect(within(logsPanel).getByText("Live log stream")).toBeInTheDocument();
      expect(within(logsPanel).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });
  });

  it("renders incident timeline alert rows", async () => {
    renderHealthcheck();
    await waitFor(
      () => {
        expect(screen.getByText(mockHistory[0].ruleName)).toBeInTheDocument();
      },
    );
    expect(screen.getByText(mockHistory[0].serviceName)).toBeInTheDocument();
  });

  it("deep-links to the Logs tab via ?tab=logs", async () => {
    renderHealthcheck("/healthcheck?tab=logs");
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Live log stream");
  });
});
