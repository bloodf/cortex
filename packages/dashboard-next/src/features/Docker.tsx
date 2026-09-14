import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Play, Square, RotateCw, Trash2, FileText, Container, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Tabs, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailDrawer } from "@/components/DetailDrawer";
import { TableSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { api, callDockerAction, callMintApproval, callContainerLogs } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import { bytes, relativeTime } from "@/lib/format";
import type { DockerContainer, DockerImage, DockerVolume } from "@/mocks/types";
import { cn } from "@/lib/utils";
import { LogStream } from "@/components/LogStream";

// ---------------------------------------------------------------------------
// Approval-gated docker action helper
// ---------------------------------------------------------------------------

/**
 * Mint an approval token then dispatch the docker action.
 * The bridge (PB-5) requires a valid token for every op.
 * On error, surfaces a user-facing toast and re-throws so callers can reset state.
 */
async function dispatchDockerAction(op: string, args: Record<string, unknown>): Promise<void> {
  // 1. Mint a single-use approval token for this exact op+args.
  const mint = await callMintApproval({
    data: { action: op, payload: { op, args } },
    headers: csrfHeaders(),
  });

  // 2. Dispatch via dockerAction, passing the token.
  await callDockerAction({
    data: { op, args, approvalToken: mint.token },
    headers: csrfHeaders(),
  });
}

/**
 * True when an action is in flight for THIS container. `pendingAction` is
 * keyed `${op}-${id}` (see dockerAction); match on the `-${id}` suffix, never a
 * bare `id` prefix (the key starts with the op, not the id). Exported for test.
 */
export function isContainerActionPending(pendingAction: string | null, id: string): boolean {
  return pendingAction?.endsWith(`-${id}`) ?? false;
}

export function DockerPage() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const {
    data: containers = [],
    isLoading: lc,
    isError: ec,
  } = useQuery({
    queryKey: ["docker", "containers"],
    queryFn: api.docker.containers,
    refetchInterval: 10_000,
  });
  const {
    data: images = [],
    isLoading: li,
    isError: ei,
  } = useQuery({
    queryKey: ["docker", "images"],
    queryFn: api.docker.images,
    refetchInterval: 30_000,
  });
  const {
    data: volumes = [],
    isLoading: lv,
    isError: ev,
  } = useQuery({
    queryKey: ["docker", "volumes"],
    queryFn: api.docker.volumes,
    refetchInterval: 30_000,
  });
  const [logsFor, setLogsFor] = useState<DockerContainer | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // MP-009: per-container log fetcher. Captures `logsFor` (the container
  // currently in the drawer) at render time; the LogStream re-runs the
  // callback when the drawer content changes (logsFor is in the dep array).
  // Errors PROPAGATE — LogStream's polling effect catches them and keeps
  // the previously rendered lines on screen rather than blanking the view
  // on a transient failure.
  const fetchContainerLogs = useCallback(async (): Promise<string[]> => {
    if (!logsFor) return [];
    const { lines } = await callContainerLogs({ data: { id: logsFor.id, limit: 200 } });
    return lines;
  }, [logsFor]);

  const isAdmin = !!user?.is_admin;

  const invalidateContainers = () => {
    qc.invalidateQueries({ queryKey: ["docker", "containers"] }).catch(() => {});
  };

  const dockerAction = async (
    op: string,
    successVerb: string,
    errorVerb: string,
    c: DockerContainer,
  ) => {
    const key = `${op}-${c.id}`;
    setPendingAction(key);
    try {
      await dispatchDockerAction(`docker.${op}`, { container: c.id });
      toast.success(`${successVerb} ${c.name}`);
      invalidateContainers();
    } catch {
      toast.error(`Failed to ${errorVerb} ${c.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const containerCols: Column<DockerContainer>[] = [
    {
      key: "name",
      header: "Name",
      sort: (r) => r.name,
      cell: (r) => (
        <a href={`/docker/${r.id}`} className="font-medium hover:underline">
          {r.name}
        </a>
      ),
    },
    {
      key: "image",
      header: "Image",
      sort: (r) => r.image,
      cell: (r) => <code className="text-xs">{r.image}</code>,
    },
    {
      key: "state",
      header: "State",
      sort: (r) => r.state,
      cell: (r) => (
        <Tag
          variant="outlined"
          className={cn(
            r.state === "running" && "border-[var(--success)] text-[var(--success)]",
            r.state === "exited" && "border-[var(--destructive)] text-[var(--destructive)]",
            r.state === "restarting" && "border-[var(--warning)] text-[var(--warning)]",
          )}
        >
          {r.state}
        </Tag>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => <span className="text-xs text-muted-foreground">{r.status}</span>,
    },
    {
      key: "ports",
      header: "Ports",
      cell: (r) => <code className="text-xs">{r.ports}</code>,
    },
    {
      key: "act",
      header: "",
      className: "text-right",
      cell: (r) => {
        const isActing = isContainerActionPending(pendingAction, r.id);
        return (
          <div className="flex gap-1 justify-end">
            <Button
              size="small"
              type="text"
              onClick={() => setLogsFor(r)}
              title="Logs"
              aria-label="Logs"
            >
              <FileText className="size-3.5" />
            </Button>
            {r.state !== "running" ? (
              <Button
                size="small"
                type="text"
                disabled={!isAdmin || isActing}
                onClick={() => dockerAction("start", "Started", "start", r)}
                title="Start"
                aria-label="Start"
              >
                {isActing && pendingAction === `start-${r.id}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </Button>
            ) : (
              <Button
                size="small"
                type="text"
                disabled={!isAdmin || isActing}
                onClick={() => dockerAction("stop", "Stopped", "stop", r)}
                title="Stop"
                aria-label="Stop"
              >
                {isActing && pendingAction === `stop-${r.id}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
              </Button>
            )}
            <Button
              size="small"
              type="text"
              disabled={!isAdmin || isActing}
              onClick={() => dockerAction("restart", "Restarted", "restart", r)}
              title="Restart"
              aria-label="Restart"
            >
              {isActing && pendingAction === `restart-${r.id}` ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCw className="size-3.5" />
              )}
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  size="small"
                  type="text"
                  danger
                  disabled={!isAdmin || isActing}
                  className="text-destructive hover:text-destructive"
                  title="Remove"
                  aria-label="Remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              }
              title={`Remove container ${r.name}?`}
              description="This will permanently remove the container. Volumes are kept."
              destructive
              requireText={r.name}
              confirmLabel="Remove"
              onConfirm={() => dockerAction("rm", "Removed", "remove", r)}
            />
          </div>
        );
      },
    },
  ];

  const imageCols: Column<DockerImage>[] = [
    {
      key: "repo",
      header: "Repository",
      sort: (r) => r.repo,
      cell: (r) => <span className="font-mono text-xs">{r.repo}</span>,
    },
    {
      key: "tag",
      header: "Tag",
      sort: (r) => r.tag,
      cell: (r) => <Tag>{r.tag}</Tag>,
    },
    {
      key: "size",
      header: "Size",
      sort: (r) => r.size ?? -1,
      className: "text-right tabular-nums",
      cell: (r) => (r.size === null ? "—" : bytes(r.size)),
    },
    {
      key: "created",
      header: "Created",
      sort: (r) => r.created,
      cell: (r) => <span className="text-xs text-muted-foreground">{relativeTime(r.created)}</span>,
    },
    {
      key: "id",
      header: "ID",
      cell: (r) => <code className="text-[11px] text-muted-foreground">{r.id.slice(7, 19)}</code>,
    },
  ];

  const volumeCols: Column<DockerVolume>[] = [
    {
      key: "name",
      header: "Name",
      sort: (r) => r.name,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "driver",
      header: "Driver",
      cell: (r) => <Tag variant="outlined">{r.driver}</Tag>,
    },
    {
      key: "mount",
      header: "Mountpoint",
      cell: (r) => <code className="text-[11px] text-muted-foreground">{r.mountpoint}</code>,
    },
    {
      key: "size",
      header: "Size",
      sort: (r) => r.size ?? -1,
      className: "text-right tabular-nums",
      cell: (r) => (r.size === null ? "—" : bytes(r.size)),
    },
  ];

  let containersPanel;
  if (lc) {
    containersPanel = <TableSkeleton rows={6} cols={5} />;
  } else if (ec) {
    containersPanel = (
      <EmptyState
        title="Failed to load containers"
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
    );
  } else {
    containersPanel = (
      <DataTable
        columns={containerCols}
        initialSort="name"
        server={{ queryKey: ["docker", "containers"], fetch: api.docker.containersList }}
      />
    );
  }

  let imagesPanel;
  if (li) {
    imagesPanel = <TableSkeleton rows={6} cols={5} />;
  } else if (ei) {
    imagesPanel = (
      <EmptyState
        title="Failed to load images"
        description="Could not reach Docker. Check that the Docker daemon is running."
      />
    );
  } else {
    imagesPanel = (
      <DataTable
        columns={imageCols}
        initialSort="repo"
        server={{ queryKey: ["docker", "images"], fetch: api.docker.imagesList }}
      />
    );
  }

  let volumesPanel;
  if (lv) {
    volumesPanel = <TableSkeleton rows={4} cols={4} />;
  } else if (ev) {
    volumesPanel = (
      <EmptyState
        title="Failed to load volumes"
        description="Could not reach Docker. Check that the Docker daemon is running."
      />
    );
  } else {
    volumesPanel = (
      <DataTable
        columns={volumeCols}
        initialSort="name"
        server={{ queryKey: ["docker", "volumes"], fetch: api.docker.volumesList }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Container className="size-5" />}
        title={t.nav.docker}
        description={`${containers.filter((c) => c.state === "running").length} running · ${images.length} images · ${volumes.length} volumes`}
      />

      <Tabs
        className="space-y-4"
        defaultActiveKey="containers"
        items={[
          {
            key: "containers",
            label: `Containers (${containers.length})`,
            children: containersPanel,
          },
          { key: "images", label: `Images (${images.length})`, children: imagesPanel },
          { key: "volumes", label: `Volumes (${volumes.length})`, children: volumesPanel },
        ]}
      />

      <DetailDrawer
        open={!!logsFor}
        onOpenChange={(o) => !o && setLogsFor(null)}
        title={logsFor ? <span className="font-mono">{logsFor.name}</span> : ""}
        description={logsFor ? `${logsFor.image} · ${logsFor.status}` : ""}
        tabs={[
          {
            id: "logs",
            label: "Logs",
            content: logsFor ? (
              <LogStream height={420} fetcher={fetchContainerLogs} refetchIntervalMs={3000} />
            ) : null,
          },
        ]}
      />
    </div>
  );
}
