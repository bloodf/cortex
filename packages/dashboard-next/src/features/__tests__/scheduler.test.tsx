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
import { SchedulerPage } from "@/features/Scheduler";
import { api } from "@/lib/api/client";
import type { SchedulerJob } from "@/mocks/types";

vi.mock("@/lib/api/client", () => ({
  api: {
    schedulerList: vi.fn(),
  },
  callSystemdAction: vi.fn(),
  callMintApproval: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "admin", is_admin: true } }),
}));

const mockJobs: SchedulerJob[] = [
  {
    id: "cortex-backup.timer",
    name: "Run Cortex full backup twice daily",
    cron: "*-*-* 00,12:00:00",
    target: "cortex-backup.service",
    lastRun: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    nextRun: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    status: "ok",
    durationMs: 42_300,
    enabled: true,
  },
  {
    id: "cortex-mail-guardian-sweep.timer",
    name: "Run Cortex Mail Guardian sweep every 5 minutes",
    cron: "*-*-* *:00/5:00",
    target: "cortex-mail-guardian-sweep.service",
    lastRun: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    nextRun: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    status: "ok",
    durationMs: 1_200,
    enabled: true,
  },
  {
    id: "logrotate.timer",
    name: "Daily rotation of log files",
    cron: "*-*-* 00:00:00",
    target: "logrotate.service",
    lastRun: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    nextRun: "",
    status: "paused",
    durationMs: 0,
    enabled: false,
  },
];

function renderScheduler(initialEntry = "/scheduler") {
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

  const schedulerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "scheduler",
    component: SchedulerPage,
  });

  const routeTree = rootRoute.addChildren([schedulerRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("SchedulerPage (MP-024a)", () => {
  beforeEach(() => {
    vi.mocked(api.schedulerList).mockResolvedValue({
      rows: mockJobs,
      total: mockJobs.length,
      page: 0,
      pageSize: 25,
    });
  });

  it("renders all 3 scheduler job rows", async () => {
    renderScheduler();
    await waitFor(
      () => {
        mockJobs.forEach((job) => {
          expect(screen.getByText(job.name)).toBeInTheDocument();
        });
      },
    );
  });

  it("renders the scheduler target for each row", async () => {
    renderScheduler();
    await waitFor(
      () => {
        mockJobs.forEach((job) => {
          expect(screen.getByText(job.target)).toBeInTheDocument();
        });
      },
    );
  });
});
