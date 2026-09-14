import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
import { DockerPage } from "@/features/Docker";
import { api } from "@/lib/api/client";
import type { DockerContainer, DockerImage, DockerVolume } from "@/mocks/types";

vi.mock("@/lib/api/client", () => ({
  api: {
    docker: {
      containers: vi.fn(),
      images: vi.fn(),
      volumes: vi.fn(),
      containersList: vi.fn(),
      imagesList: vi.fn(),
      volumesList: vi.fn(),
    },
  },
  callDockerAction: vi.fn(),
  callMintApproval: vi.fn(),
  callContainerLogs: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "admin", is_admin: true } }),
}));

const mockContainer: DockerContainer = {
  id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  name: "test-container",
  image: "test-image",
  status: "Up 1 hour",
  state: "running",
  ports: "8080:80",
  created: "2026-06-11T20:00:00.000Z",
};

function makeImage(partial: Partial<DockerImage> = {}): DockerImage {
  return {
    id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
    repo: "test-repo",
    tag: "latest",
    size: 100_000_000,
    created: "2026-06-11T20:00:00.000Z",
    ...partial,
  };
}

function makeVolume(partial: Partial<DockerVolume> = {}): DockerVolume {
  return {
    name: "test-volume",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/test-volume/_data",
    size: 100_000_000,
    ...partial,
  };
}

function renderDocker(initialEntry = "/docker") {
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

  const dockerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "docker",
    component: DockerPage,
  });

  const routeTree = rootRoute.addChildren([dockerRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("DockerPage null adapter cells (MP-027)", () => {
  beforeEach(() => {
    vi.mocked(api.docker.containers).mockResolvedValue([mockContainer]);
    vi.mocked(api.docker.images).mockResolvedValue([]);
    vi.mocked(api.docker.volumes).mockResolvedValue([]);
    vi.mocked(api.docker.containersList).mockResolvedValue({
      rows: [mockContainer],
      total: 1,
      page: 0,
      pageSize: 25,
    });
    vi.mocked(api.docker.imagesList).mockResolvedValue({
      rows: [],
      total: 0,
      page: 0,
      pageSize: 25,
    });
    vi.mocked(api.docker.volumesList).mockResolvedValue({
      rows: [],
      total: 0,
      page: 0,
      pageSize: 25,
    });
  });

  it("renders '—' for an image with null size", async () => {
    const image = makeImage({ size: null });
    vi.mocked(api.docker.images).mockResolvedValue([image]);
    vi.mocked(api.docker.imagesList).mockResolvedValue({
      rows: [image],
      total: 1,
      page: 0,
      pageSize: 25,
    });

    renderDocker();

    const imagesTab = await screen.findByRole("tab", { name: /images/i });
    await userEvent.click(imagesTab);

    await waitFor(() => {
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });

  it("renders '—' for a volume with null size", async () => {
    const volume = makeVolume({ size: null });
    vi.mocked(api.docker.volumes).mockResolvedValue([volume]);
    vi.mocked(api.docker.volumesList).mockResolvedValue({
      rows: [volume],
      total: 1,
      page: 0,
      pageSize: 25,
    });

    renderDocker();

    const volumesTab = await screen.findByRole("tab", { name: /volumes/i });
    await userEvent.click(volumesTab);

    await waitFor(() => {
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });
});
