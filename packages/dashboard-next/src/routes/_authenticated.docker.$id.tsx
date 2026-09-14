import { createFileRoute, Link, useParams, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, RotateCw, Square, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useState } from "react";
import { Button, Tabs, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { TechIcon } from "@/components/TechIcon";
import { LogStream } from "@/components/LogStream";
import { TimeRangeAreaTrend } from "@/components/TimeRangeAreaTrend";
import { FCard, FStat } from "@/components/fable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { api, callDockerAction, callMintApproval, callContainerLogs } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useAuth } from "@/hooks/useAuth";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/docker/$id")({
  loader: async ({ params }) => {
    const containers = await api.docker.containers();
    const found = containers.find((c) => c.id === params.id || c.name === params.id);
    if (!found) {
      throw notFound();
    }
    return { container: found };
  },
  errorComponent: ({ error, reset }) => (
    <div className="p-6 space-y-4">
      <PageHeader title="Container error" description={error?.message ?? "Failed to load"} />
      <Button onClick={reset}>Retry</Button>
    </div>
  ),
  notFoundComponent: NotFoundComponent,
  component: ContainerDetail,
});

// ---------------------------------------------------------------------------
// Approval-gated docker action helper (mirrors Docker.tsx)
// ---------------------------------------------------------------------------

async function dispatchDockerAction(op: string, args: Record<string, unknown>): Promise<void> {
  const mint = await callMintApproval({
    data: { action: op, payload: { op, args } },
    headers: csrfHeaders(),
  });
  await callDockerAction({
    data: { op, args, approvalToken: mint.token },
    headers: csrfHeaders(),
  });
}

function NotFoundComponent() {
  const { id } = useParams({ from: "/_authenticated/docker/$id" });
  const navigate = Route.useNavigate();
  return (
    <div className="p-6 space-y-4">
      <PageHeader title="Container not found" description={`No container matched "${id}".`} />
      <Button variant="outlined" onClick={() => navigate({ to: "/docker" })}>
        <ArrowLeft className="size-4 mr-1" />
        Back to Docker
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <FStat label={label} value={<span className="text-sm font-medium">{value}</span>} />;
}

function ContainerDetail() {
  const { id } = useParams({ from: "/_authenticated/docker/$id" });
  const qc = useQueryClient();
  const navigate = Route.useNavigate();
  const { user } = useAuth();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const {
    data: containers = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["docker", "containers"],
    queryFn: api.docker.containers,
    refetchInterval: 10_000,
  });

  const c = containers.find((x) => x.id === id || x.name === id);
  const isAdmin = !!user?.is_admin;

  // MP-009: container-scoped log fetcher. Captures `c` (the route's
  // resolved container) at render time; the LogStream re-runs the
  // callback when the route param / containers list changes.
  // Errors PROPAGATE — LogStream's polling effect catches them and keeps
  // the previously rendered lines on screen rather than blanking the view
  // on a transient failure.
  const fetchContainerLogs = useCallback(async (): Promise<string[]> => {
    if (!c) return [];
    const { lines } = await callContainerLogs({ data: { id: c.id, limit: 200 } });
    return lines;
  }, [c]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["docker", "containers"] });

  const handleStart = async () => {
    if (!c) return;
    setPendingAction("start");
    try {
      await dispatchDockerAction("docker.start", { container: c.id });
      toast.success(`Started ${c.name}`);
      await invalidate();
    } catch {
      toast.error(`Failed to start ${c.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleStop = async () => {
    if (!c) return;
    setPendingAction("stop");
    try {
      await dispatchDockerAction("docker.stop", { container: c.id });
      toast.success(`Stopped ${c.name}`);
      await invalidate();
    } catch {
      toast.error(`Failed to stop ${c.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleRestart = async () => {
    if (!c) return;
    setPendingAction("restart");
    try {
      await dispatchDockerAction("docker.restart", { container: c.id });
      toast.success(`Restarted ${c.name}`);
      await invalidate();
    } catch {
      toast.error(`Failed to restart ${c.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleRemove = async () => {
    if (!c) return;
    setPendingAction("rm");
    try {
      await dispatchDockerAction("docker.rm", { container: c.id });
      toast.success(`Removed ${c.name}`);
      qc.invalidateQueries({ queryKey: ["docker", "containers"] }).catch(() => {});
    } catch {
      toast.error(`Failed to remove ${c.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Button
          size="small"
          type="text"
          className="-ml-2"
          onClick={() => navigate({ to: "/docker" })}
        >
          <ArrowLeft className="size-3.5 mr-1" />
          Docker
        </Button>
        <DetailSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4 p-6">
        <EmptyState
          title="Failed to load container"
          description="Could not reach Docker. Check that the Docker daemon is running."
          action={
            <Button
              size="small"
              variant="outlined"
              onClick={() => qc.invalidateQueries({ queryKey: ["docker", "containers"] })}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!c) {
    return (
      <div className="p-6">
        <EmptyState
          title="Container not loaded"
          description="No container data is available. Try again or return to the list."
        />
      </div>
    );
  }

  const acting = pendingAction !== null;

  return (
    <div className="space-y-5">
      <Button
        size="small"
        type="text"
        className="-ml-2"
        onClick={() => navigate({ to: "/docker" })}
      >
        <ArrowLeft className="size-3.5 mr-1" />
        Docker
      </Button>

      <PageHeader
        icon={<TechIcon slug={c.name} name={c.name} size={36} />}
        title={c.name}
        description={`${c.image} · ${c.status}`}
        actions={
          <div className="flex gap-2">
            <Tag
              variant="outlined"
              className={cn(
                c.state === "running" && "border-[var(--success)] text-[var(--success)]",
                c.state === "exited" && "border-destructive text-destructive",
              )}
            >
              {c.state}
            </Tag>
            {isAdmin && c.state !== "running" && (
              <Button size="small" variant="outlined" disabled={acting} onClick={handleStart}>
                {pendingAction === "start" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="size-3.5 mr-1" />
                )}
                Start
              </Button>
            )}
            {isAdmin && c.state === "running" && (
              <Button size="small" variant="outlined" disabled={acting} onClick={handleStop}>
                {pendingAction === "stop" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Square className="size-3.5 mr-1" />
                )}
                Stop
              </Button>
            )}
            {isAdmin && (
              <Button size="small" variant="outlined" disabled={acting} onClick={handleRestart}>
                {pendingAction === "restart" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5 mr-1" />
                )}
                Restart
              </Button>
            )}
            {isAdmin && (
              <ConfirmDialog
                trigger={
                  <Button
                    size="small"
                    variant="outlined"
                    danger
                    disabled={acting}
                    className="text-destructive hover:text-destructive border-destructive/40"
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    Remove
                  </Button>
                }
                title={`Remove container ${c.name}?`}
                description="This will permanently remove the container. Volumes are kept."
                destructive
                requireText={c.name}
                confirmLabel="Remove"
                onConfirm={handleRemove}
              />
            )}
          </div>
        }
      />

      <div className="grid lg:grid-cols-3 gap-4">
        <Stat label="State" value={c.state} />
        <Stat label="Ports" value={c.ports || "—"} />
        <Stat label="Created" value={relativeTime(c.created)} />
      </div>

      <Tabs
        defaultActiveKey="metrics"
        items={[
          {
            key: "metrics",
            label: "Metrics",
            children: (
              <div className="pt-4">
                <p className="text-sm text-muted-foreground">
                  Metrics not yet wired. See <Link to="/docker">container list</Link> for state.
                </p>
              </div>
            ),
          },
          {
            key: "logs",
            label: "Logs",
            children: (
              <div className="pt-4">
                <LogStream height={480} fetcher={fetchContainerLogs} refetchIntervalMs={3000} />
              </div>
            ),
          },
          {
            key: "config",
            label: "Config",
            children: (
              <div className="pt-4">
                <FCard className="p-4 overflow-x-auto">
                  <pre className="text-xs">{JSON.stringify(c, null, 2)}</pre>
                </FCard>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
