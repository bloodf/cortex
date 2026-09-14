import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminBadgesPage } from "@/features/admin/Badges";
import * as rpc from "@/features/admin/rpc";

vi.mock("@/features/admin/rpc", () => ({
  listAdminBadges: vi.fn(),
  createAdminBadge: vi.fn(),
  patchAdminBadge: vi.fn(),
  deleteAdminBadge: vi.fn(),
}));

const mockBadges = [
  { id: 1, slug: "beta", label: "Beta", color: "#1f2937", textColor: "#ffffff" },
  { id: 2, slug: "infra", label: "Infra", color: "#0e7490", textColor: "#ffffff" },
];

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminBadgesPage />
    </QueryClientProvider>,
  );
}

describe("AdminBadgesPage", () => {
  beforeEach(() => {
    vi.mocked(rpc.listAdminBadges).mockResolvedValue(mockBadges);
  });

  it("renders every badge label and slug from the live list", async () => {
    renderPage();
    await waitFor(() => {
      mockBadges.forEach((b) => {
        expect(screen.getAllByText(b.label).length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText(b.slug)).toBeInTheDocument();
      });
    });
  });

  it("shows the badge count and an Add badge action", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2 badges")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add badge/i })).toBeInTheDocument();
    });
  });
});
