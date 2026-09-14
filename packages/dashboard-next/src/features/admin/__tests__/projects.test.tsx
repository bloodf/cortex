import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminProjectsPage } from "@/features/admin/Projects";
import * as rpc from "@/features/admin/rpc";

vi.mock("@/features/admin/rpc", () => ({
  listAdminProjects: vi.fn(),
  createAdminProject: vi.fn(),
  patchAdminProject: vi.fn(),
  deleteAdminProject: vi.fn(),
}));

const mockProjects = [
  {
    id: 1,
    slug: "cortex",
    name: "Example project",
    repoUrl: "https://github.com/org/cortex",
    primaryPmAccount: "@op",
    messagingMode: "single" as const,
  },
  {
    id: 2,
    slug: "hermes",
    name: "Hermes",
    repoUrl: null,
    primaryPmAccount: null,
    messagingMode: "distributed" as const,
  },
];

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminProjectsPage />
    </QueryClientProvider>,
  );
}

describe("AdminProjectsPage", () => {
  beforeEach(() => {
    vi.mocked(rpc.listAdminProjects).mockResolvedValue(mockProjects);
  });

  it("renders every project name and slug from the live list", async () => {
    renderPage();
    await waitFor(() => {
      mockProjects.forEach((p) => {
        expect(screen.getByText(p.name)).toBeInTheDocument();
        expect(screen.getByText(p.slug)).toBeInTheDocument();
      });
    });
  });

  it("renders an em dash for a null repository and an Add project action", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2 projects")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add project/i })).toBeInTheDocument();
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    });
  });
});
