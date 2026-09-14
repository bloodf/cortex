import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import { BackupsPage } from "@/features/Backups";
import { api } from "@/lib/api/client";
import type { BackupRunRow } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  api: {
    backups: vi.fn(),
    backupsList: vi.fn(),
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "admin", is_admin: true } }),
}));

const mockBackups: BackupRunRow[] = [
  {
    id: "cortex-20260901T120000.000000Z",
    target: "/var/lib/cortex/backups/cortex-20260901T120000.000000Z.tar.gz",
    timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    sizeBytes: 3_179_539_601,
    status: "success",
  },
  {
    id: "cortex-20260901T000000.000000Z",
    target: "/var/lib/cortex/backups/cortex-20260901T000000.000000Z.tar.partial",
    timestamp: new Date(Date.now() - 16 * 60 * 60 * 1000).toISOString(),
    sizeBytes: null,
    status: "running",
  },
  {
    id: "cortex-20260831T120000.000000Z",
    target: "/var/lib/cortex/backups/cortex-20260831T120000.000000Z.tar.gz",
    timestamp: new Date(Date.now() - 28 * 60 * 60 * 1000).toISOString(),
    sizeBytes: null,
    status: "unknown",
  },
];

function renderBackups(initialEntry = "/backups") {
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

  const backupsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "backups",
    component: BackupsPage,
  });

  const routeTree = rootRoute.addChildren([backupsRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("BackupsPage (MP-024b)", () => {
  beforeEach(() => {
    vi.mocked(api.backups).mockResolvedValue(mockBackups);
    vi.mocked(api.backupsList).mockResolvedValue({
      rows: mockBackups,
      total: mockBackups.length,
      page: 0,
      pageSize: 25,
    });
  });

  it("renders all 3 backup rows", async () => {
    renderBackups();
    await waitFor(() => {
      mockBackups.forEach((backup) => {
        expect(screen.getByText(backup.target)).toBeInTheDocument();
      });
    });
  });

  it("renders a status badge for every row", async () => {
    renderBackups();
    await waitFor(() => {
      mockBackups.forEach((backup) => {
        expect(screen.getAllByText(backup.status).length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  it("renders null sizeBytes as an em dash, not 0 B", async () => {
    renderBackups();
    const { target } = mockBackups.find((b) => b.sizeBytes === null)!;
    await waitFor(() => {
      expect(screen.getByText(target)).toBeInTheDocument();
    });
    const row = screen.getByText(target).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).queryByText("0 B")).not.toBeInTheDocument();
  });

  it("renders a running indicator for running backups", async () => {
    renderBackups();
    await waitFor(() => {
      expect(screen.getByText("running")).toBeInTheDocument();
    });
  });

  it("renders an unknown status badge for unknown backups", async () => {
    renderBackups();
    await waitFor(() => {
      expect(screen.getByText("unknown")).toBeInTheDocument();
    });
  });
});
