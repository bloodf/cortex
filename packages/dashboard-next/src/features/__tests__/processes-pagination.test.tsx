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
import { ProcessesPage } from "@/features/Processes";
import { api } from "@/lib/api/client";
import type { ProcessInfo } from "@/lib/api/client";

// The Processes list must paginate. Rendering every host process (hundreds)
// unpaginated mounts a per-row confirm dialog for admins, which crashed the
// page. This guards against a regression to `paginate={false}`.
vi.mock("@/lib/api/client", () => ({
  api: { processes: vi.fn() },
  callMintApproval: vi.fn(),
  callKillProcess: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "root", is_admin: true } }),
}));

const PAGE_SIZE = 25;

function makeProcs(n: number): ProcessInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    pid: 1000 + i,
    user: `user${i % 5}`,
    command: `/usr/bin/proc-${i} --flag`,
    cpu: (i % 100) / 10,
    mem: (i % 50) / 10,
  }));
}

function renderProcesses() {
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
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "processes",
    component: ProcessesPage,
  });
  const routeTree = rootRoute.addChildren([route]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/processes"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("ProcessesPage list pagination (crash guard)", () => {
  beforeEach(() => {
    vi.mocked(api.processes).mockResolvedValue(makeProcs(696));
  });

  it("caps the rendered list at one page even with 696 processes", async () => {
    renderProcesses();

    // Wait until the first page of rows has rendered.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Terminate PID/ }).length).toBeGreaterThan(0),
    );

    // Admin sees one Terminate + one Force-kill button per row. If pagination
    // is disabled, all 696 rows (1392 buttons) mount at once — the crash.
    // 696 processes fills a full first page exactly. Both the Terminate and
    // Force-kill buttons must be present for every rendered row, and no more
    // than one page of them may mount.
    const terminate = screen.getAllByRole("button", { name: /Terminate PID/ });
    const forceKill = screen.getAllByRole("button", { name: /Force kill PID/ });
    expect(terminate.length).toBe(PAGE_SIZE);
    expect(forceKill.length).toBe(PAGE_SIZE);
  });
});
