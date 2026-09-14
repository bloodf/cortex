import { createFileRoute, Link, useParams, notFound, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, RotateCw, Square, Trash2, Boxes, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Button, Tabs, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { FCard, FTerminal } from "@/components/fable";
import { CodeBlock } from "@/components/CodeBlock";
import { KeyValueList } from "@/components/KeyValueList";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { TimeRangeAreaTrend } from "@/components/TimeRangeAreaTrend";
import { api, callIncusAction, callMintApproval, callInstanceLogs } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useAuth } from "@/hooks/useAuth";
import { bytes, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Approval-gated incus action helper (mirrors dispatchDockerAction)
// ---------------------------------------------------------------------------

async function dispatchIncusAction(
  action: "start" | "stop" | "restart" | "delete",
  name: string,
  confirmation?: string,
): Promise<void> {
  const mint = await callMintApproval({
    // Payload MUST be `{ name }` only — the incus bridge binds its approval
    // token to `actionHashFor(`incus.${action}`, { name })` (bridge.ts ~1480
    // destructive, ~1202 launch). Including `action` here would change the
    // hash shape and fail-close every UI-driven action with approval_invalid.
    data: { action: `incus.${action}`, payload: { name } },
    headers: csrfHeaders(),
  });
  await callIncusAction({
    data: { action, name, confirmation, approvalToken: mint.token },
    headers: csrfHeaders(),
  });
}

function NotFoundComponent() {
  const { name } = useParams({ from: "/_authenticated/incus/$name" });
  const navigate = useNavigate();
  return (
    <div className="p-6">
      <PageHeader title="Instance not found" description={`No Incus instance matched "${name}".`} />
      <Button variant="outlined" onClick={() => navigate({ to: "/incus" })}>
        <ArrowLeft className="size-4 mr-1" />
        Back to Incus
      </Button>
    </div>
  );
}

const statusColors: Record<string, string> = {
  active: "border-[var(--success)] text-[var(--success)]",
  running: "border-[var(--success)] text-[var(--success)]",
  provisioning: "border-[var(--warning)] text-[var(--warning)]",
  validated: "border-primary text-primary",
  draft: "border-muted-foreground text-muted-foreground",
  stopped: "border-muted-foreground text-muted-foreground",
  frozen: "border-muted-foreground text-muted-foreground",
  failed: "border-[var(--destructive)] text-[var(--destructive)]",
  error: "border-[var(--destructive)] text-[var(--destructive)]",
};

function IncusDetail() {
  const { name } = useParams({ from: "/_authenticated/incus/$name" });
  const qc = useQueryClient();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const {
    data: instances = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["incus", name],
    queryFn: api.incus,
    refetchInterval: 15_000,
  });

  const { data: logsData } = useQuery({
    queryKey: ["incus", "logs", name],
    queryFn: () => callInstanceLogs({ data: { name, tail: 100 } }),
    refetchInterval: 10_000,
  });

  const inst = instances.find((i) => i.name === name || i.slug === name);
  const isAdmin = !!user?.is_admin;
  const acting = pendingAction !== null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["incus"] }).catch(() => {});
  };

  const handleStart = async () => {
    if (!inst) return;
    setPendingAction("start");
    try {
      await dispatchIncusAction("start", inst.name);
      toast.success(`Started ${inst.name}`);
      await invalidate();
    } catch {
      toast.error(`Failed to start ${inst.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleStop = async () => {
    if (!inst) return;
    setPendingAction("stop");
    try {
      await dispatchIncusAction("stop", inst.name);
      toast.success(`Stopped ${inst.name}`);
      await invalidate();
    } catch {
      toast.error(`Failed to stop ${inst.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleRestart = async () => {
    if (!inst) return;
    setPendingAction("restart");
    try {
      await dispatchIncusAction("restart", inst.name);
      toast.success(`Restarted ${inst.name}`);
      await invalidate();
    } catch {
      toast.error(`Failed to restart ${inst.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleDelete = async () => {
    if (!inst) return;
    setPendingAction("delete");
    try {
      await dispatchIncusAction("delete", inst.name, "delete");
      toast.success(`Deleted ${inst.name}`);
      qc.invalidateQueries({ queryKey: ["incus"] }).catch(() => {});
    } catch {
      toast.error(`Failed to delete ${inst.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Button
          type="text"
          size="small"
          className="-ml-2"
          onClick={() => navigate({ to: "/incus" })}
        >
          <ArrowLeft className="size-3.5 mr-1" />
          Incus
        </Button>
        <DetailSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4 p-6">
        <EmptyState
          title="Failed to load instance"
          description="Could not reach the Incus bridge."
          action={
            <Button
              size="small"
              variant="outlined"
              onClick={() => qc.invalidateQueries({ queryKey: ["incus"] })}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!inst) {
    return (
      <div className="p-6">
        <EmptyState
          title="Instance not loaded"
          description="No instance data is available. Try again or return to the list."
        />
      </div>
    );
  }

  const isRunning = (inst.status as string) === "active" || (inst.status as string) === "running";

  const devicesCfg = Object.entries(inst.devices)
    .map(
      ([k, v]) =>
        `${k}:\n${Object.entries(v)
          .map(([kk, vv]) => `  ${kk}: ${vv}`)
          .join("\n")}`,
    )
    .join("\n");

  const logLines = logsData?.lines ?? [];

  return (
    <div className="space-y-5">
      <Button type="text" size="small" className="-ml-2" onClick={() => navigate({ to: "/incus" })}>
        <ArrowLeft className="size-3.5 mr-1" />
        Incus
      </Button>

      <PageHeader
        icon={<Boxes className="size-5" />}
        title={inst.name}
        description={`${inst.type} · ${inst.image}`}
        actions={
          <div className="flex gap-2">
            <Tag variant="outlined" className={cn(statusColors[inst.status] ?? "")}>
              {inst.status}
            </Tag>
            {isAdmin && !isRunning && (
              <Button size="small" variant="outlined" disabled={acting} onClick={handleStart}>
                {pendingAction === "start" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="size-3.5 mr-1" />
                )}
                Start
              </Button>
            )}
            {isAdmin && isRunning && (
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
                    disabled={acting}
                    className="text-destructive hover:text-destructive border-destructive/40"
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    Delete
                  </Button>
                }
                title={`Delete instance ${inst.name}?`}
                description="This will permanently delete the instance. This cannot be undone."
                destructive
                requireText={inst.name}
                confirmLabel="Delete"
                onConfirm={handleDelete}
              />
            )}
          </div>
        }
      />

      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: "overview",
            label: "Overview",
            children: (
              <div className="pt-4">
                <FCard className="p-4">
                  <KeyValueList
                    items={[
                      { key: "Type", value: inst.type },
                      { key: "Image", value: inst.image },
                      { key: "CPU", value: inst.cpu === null ? "—" : inst.cpu },
                      {
                        key: "Memory",
                        value: inst.memory === null ? "—" : bytes(inst.memory * 1024 * 1024),
                      },
                      { key: "Created", value: relativeTime(inst.created_at) },
                      {
                        key: "Validation",
                        value: inst.last_validation?.notes ?? "—",
                      },
                      { key: "Repo", value: inst.project.repo_url || "—" },
                      {
                        key: "Branch",
                        value: <code className="text-xs">{inst.project.branch}</code>,
                      },
                    ]}
                  />
                </FCard>
              </div>
            ),
          },
          {
            key: "metrics",
            label: "Metrics",
            children: (
              <div className="pt-4">
                <p className="text-sm text-muted-foreground">
                  Metrics not yet wired. See <Link to="/incus">instance list</Link> for state.
                </p>
              </div>
            ),
          },
          {
            key: "logs",
            label: "Logs",
            children: (
              <div className="pt-4">
                {logLines.length === 0 ? (
                  <EmptyState title="No logs" description="No log lines found for this instance." />
                ) : (
                  <FCard className="p-3">
                    <FTerminal className="max-h-96 space-y-0.5">
                      {logLines.map((line, i) => (
                        <div key={i} className="flex gap-2">
                          <span
                            className={cn(
                              "shrink-0 w-12 text-right",
                              line.priority === "error" && "text-[var(--destructive)]",
                              line.priority === "warn" && "text-[var(--warning)]",
                              line.priority === "debug" && "text-muted-foreground",
                              line.priority === "info" && "text-[var(--success)]",
                            )}
                          >
                            {line.priority}
                          </span>
                          <span className="text-muted-foreground shrink-0">
                            {new Date(line.ts).toLocaleTimeString()}
                          </span>
                          <span>{line.message}</span>
                        </div>
                      ))}
                    </FTerminal>
                  </FCard>
                )}
              </div>
            ),
          },
          {
            key: "config",
            label: "Config",
            children: (
              <div className="pt-4">
                <FCard className="p-4">
                  <CodeBlock language="yaml" code={devicesCfg} />
                </FCard>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/incus/$name")({
  loader: async ({ params }) => {
    const all = await api.incus();
    const found = all.find((i) => i.name === params.name || i.slug === params.name);
    if (!found) {
      throw notFound();
    }
    return { instance: found };
  },
  errorComponent: ({ error, reset }) => (
    <div className="p-6 space-y-4">
      <PageHeader title="Instance error" description={error?.message ?? "Failed to load"} />
      <Button type="primary" onClick={reset}>
        Retry
      </Button>
    </div>
  ),
  notFoundComponent: NotFoundComponent,
  component: IncusDetail,
});
