import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProvider } from "@/hooks/ui-provider";
import { NetworkPage } from "@/features/Network";
import { api } from "@/lib/api/client";
import type { NetworkData } from "@/mocks/types";
import source from "@/features/Network.tsx?raw";

vi.mock("@/lib/api/client", () => ({
  api: {
    network: vi.fn(),
  },
}));

const mockNetwork: NetworkData = {
  interfaces: [
    {
      name: "eth0",
      rxKbps: 120,
      txKbps: 45,
      rxBytesTotal: 1_000_000,
      txBytesTotal: 500_000,
    },
  ],
};

function renderNetwork() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <NetworkPage />
      </UIProvider>
    </QueryClientProvider>,
  );
}

describe("Network page (MP-026 RED)", () => {
  beforeEach(() => {
    vi.mocked(api.network).mockResolvedValue(mockNetwork);
  });

  it("renders the interface list without the topology section", async () => {
    renderNetwork();
    await waitFor(() => {
      expect(screen.getByText("eth0")).toBeInTheDocument();
    });
    expect(screen.queryByText("Network topology")).not.toBeInTheDocument();
  });

  it("does not import from @/mocks in the component source", () => {
    expect(source).not.toMatch(/@\/mocks/);
  });
});
