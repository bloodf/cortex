import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { IncidentToaster } from "@/components/IncidentToaster";
import { api } from "@/lib/api/client";
import type { AlertHistory } from "@/mocks/types";
import source from "@/components/IncidentToaster.tsx?raw";

vi.mock("@/lib/api/client", () => ({
  api: {
    alerts: {
      history: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

const preExistingAlert: AlertHistory = {
  id: "ah-1",
  ruleName: "CPU threshold",
  serviceName: "node",
  status: "fired",
  message: "overload",
  timestamp: new Date().toISOString(),
};

const newAlert: AlertHistory = {
  id: "ah-2",
  ruleName: "Database connection",
  serviceName: "postgresql",
  status: "resolved",
  message: "connection restored",
  timestamp: new Date().toISOString(),
};

function renderToaster() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IncidentToaster />
    </QueryClientProvider>,
  );
}

describe("IncidentToaster live wiring (MP-026 RED)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses pre-existing alerts on first load, toasts each new alert once, and dedups across polls", async () => {
    vi.mocked(api.alerts.history)
      .mockResolvedValueOnce([preExistingAlert])
      .mockResolvedValueOnce([preExistingAlert, newAlert])
      .mockResolvedValueOnce([preExistingAlert, newAlert]);

    renderToaster();

    // First poll: the batch is treated as seed data; no toasts fire.
    await vi.waitFor(() => expect(api.alerts.history).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);

    // Second poll: the new alert surfaces as exactly one toast.
    await vi.waitFor(() => expect(api.alerts.history).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);

    // Third poll: same payload returns; no duplicate toasts.
    await vi.waitFor(() => expect(api.alerts.history).toHaveBeenCalledTimes(3));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("does not import from @/mocks in the component source", () => {
    expect(source).not.toMatch(/@\/mocks/);
  });
});
