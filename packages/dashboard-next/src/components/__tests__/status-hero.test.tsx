import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusHero } from "@/components/StatusHero";
import { api } from "@/lib/api/client";
import type { Service, SystemData } from "@/mocks/types";
import source from "@/components/StatusHero.tsx?raw";

vi.mock("@/lib/api/client", () => ({
  api: {
    services: vi.fn(),
    system: vi.fn(),
  },
}));

const mockServices: Service[] = [
  {
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
  },
  {
    id: 2,
    slug: "db",
    name: "Database",
    open_url: "https://dashboard.example.com/db",
    category: "Core",
    status: "online",
    responseTime: 8,
    icon_color: null,
    icon_image: null,
    kind: "service",
    health_url: "https://dashboard.example.com/db/health",
    health_type: "tcp",
    description: "Postgres",
    env_source: null,
    is_active: true,
    has_webui: true,
    show_in_healthcheck: true,
    show_in_webui: true,
    sort_order: 2,
    icon_type: "auto",
    badges: [],
  },
];

const mockSystem: SystemData = {
  cpu: 12,
  memory: { percent: 34, used: 4, total: 16 },
  drives: [],
  mounts: [],
  load: [0],
  uptime: 123,
  sensors: {
    cpuTemperature: null,
    temperatures: [],
    fans: [],
    voltages: [],
  },
};

function renderHero() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StatusHero />
    </QueryClientProvider>,
  );
}

describe("StatusHero live wiring (MP-026 RED)", () => {
  beforeEach(() => {
    vi.mocked(api.services).mockResolvedValue(mockServices);
    vi.mocked(api.system).mockResolvedValue(mockSystem);
  });

  it("renders services and system stats from the mocked live client", async () => {
    renderHero();
    await waitFor(() => {
      expect(screen.getByText(/2 services online/)).toBeInTheDocument();
    });
    const detail = screen.getByText(/2 services online/);
    expect(detail).toHaveTextContent("CPU 12%");
    expect(detail).toHaveTextContent("Mem 34%");
  });

  it("does not import from @/mocks in the component source", () => {
    expect(source).not.toMatch(/@\/mocks/);
  });
});
