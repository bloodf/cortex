import { createFileRoute, useParams, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, RotateCw, Square, Loader2, Server } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Button, Tabs, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { FCard } from "@/components/fable";
import { KeyValueList } from "@/components/KeyValueList";
import { LogViewer } from "@/components/LogViewer";
import { DetailSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { api, callSystemdAction, callMintApproval, callUnitLogs } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/systemd/$unit")({
  loader: async ({ params }) => {
    const all = await api.systemd();
    const found = all.find((u) => u.name === params.unit);
    if (!found) {
      throw notFound();
    }
    return { unit: found };
  },
  notFoundComponent: NotFoundComponent,
  component: SystemdDetail,
});

// ---------------------------------------------------------------------------
// Approval-gated systemd action helper (mirrors Systemd.tsx)
// ---------------------------------------------------------------------------

async function dispatchSystemdAction(
  action: "start" | "stop" | "restart" | "reload" | "enable" | "disable",
  name: string,
): Promise<void> {
  const mint = await callMintApproval({
    data: { action: "systemd.action", payload: { action, name } },
    headers: csrfHeaders(),
  });
  await callSystemdAction({
    data: { action, name },
    headers: {
      ...csrfHeaders(),
      "x-cortex-approval-token": mint.token,
    },
  });
}

function NotFoundComponent() {
  const { unit } = useParams({ from: "/_authenticated/systemd/$unit" });
  const navigate = Route.useNavigate();
  return (
    <div className="p-6 space-y-4">
      <PageHeader title="Unit not found" description={`No systemd unit matched "${unit}".`} />
      <Button variant="outlined" onClick={() => navigate({ to: "/systemd" })}>
        <ArrowLeft className="size-4 mr-1" />
        Back to Systemd
      </Button>
    </div>
  );
}

function SystemdDetail() {
  const { unit: unitName } = useParams({ from: "/_authenticated/systemd/$unit" });
  const qc = useQueryClient();
  const navigate = Route.useNavigate();
  const { user } = useAuth();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Live unit state — refetches every 15s.
  const {
    data: units = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["systemd", "units"],
    queryFn: api.systemd,
    refetchInterval: 15_000,
  });

  // Journal logs — fetched once on mount (static snapshot).
  const {
    data: logsData,
    isLoading: logsLoading,
    isError: logsError,
    refetch: refetchLogs,
  } = useQuery({
    queryKey: ["systemd", "logs", unitName],
    queryFn: () =>
      callUnitLogs({ data: { name: unitName, limit: 200 } }) as Promise<{
        unit: string;
        limit: number;
        count: number;
        lines: string[];
      }>,
    staleTime: 30_000,
  });

  const u = units.find((x) => x.name === unitName);
  const isAdmin = !!user?.is_admin;
  const acting = pendingAction !== null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["systemd", "units"] }).catch(() => {});
  };

  const handleAction = async (
    action: "start" | "stop" | "restart" | "reload" | "enable" | "disable",
  ) => {
    setPendingAction(action);
    try {
      await dispatchSystemdAction(action, unitName);
      toast.success(`${unitName}: ${action} dispatched`);
      invalidate();
      // Also refresh logs after an action.
      refetchLogs().catch(() => {});
    } catch {
      toast.error(`Failed to ${action} ${unitName}`);
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
          onClick={() => navigate({ to: "/systemd" })}
        >
          <ArrowLeft className="size-3.5 mr-1" />
          Systemd
        </Button>
        <DetailSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4 p-6">
        <EmptyState
          title="Failed to load unit"
          description="Could not read systemd unit data. Check that systemd is available on the host."
          action={
            <Button
              size="small"
              variant="outlined"
              onClick={() => qc.invalidateQueries({ queryKey: ["systemd", "units"] })}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!u) return null;

  let logsPanel;
  if (logsLoading) {
    logsPanel = (
      <div className="rounded-md border bg-muted/30 h-64 flex items-center justify-center text-sm text-muted-foreground">
        Loading journal…
      </div>
    );
  } else if (logsError) {
    logsPanel = (
      <EmptyState
        title="Failed to load logs"
        description="Could not read journal for this unit."
        action={
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              refetchLogs().catch(() => {});
            }}
          >
            Retry
          </Button>
        }
      />
    );
  } else {
    logsPanel = (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            {logsData?.count ?? 0} lines
          </span>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              refetchLogs().catch(() => {});
            }}
          >
            Refresh
          </Button>
        </div>
        <LogViewer lines={logsData?.lines ?? []} height={420} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button
        size="small"
        type="text"
        className="-ml-2"
        onClick={() => navigate({ to: "/systemd" })}
      >
        <ArrowLeft className="size-3.5 mr-1" />
        Systemd
      </Button>

      <PageHeader
        icon={<Server className="size-5" />}
        title={u.name}
        description={u.description}
        actions={
          <div className="flex gap-2">
            <Tag
              variant="outlined"
              className={cn(
                u.active === "active" && "border-[var(--success)] text-[var(--success)]",
                u.active === "failed" && "border-destructive text-destructive",
              )}
            >
              {u.active}
            </Tag>
            {isAdmin && u.active !== "active" && (
              <Button
                size="small"
                variant="outlined"
                disabled={acting || !u.allowlisted}
                onClick={() => {
                  handleAction("start").catch(() => {});
                }}
              >
                {pendingAction === "start" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="size-3.5 mr-1" />
                )}
                Start
              </Button>
            )}
            {isAdmin && u.active === "active" && (
              <Button
                size="small"
                variant="outlined"
                disabled={acting || !u.allowlisted}
                onClick={() => {
                  handleAction("stop").catch(() => {});
                }}
              >
                {pendingAction === "stop" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Square className="size-3.5 mr-1" />
                )}
                Stop
              </Button>
            )}
            {isAdmin && (
              <Button
                size="small"
                variant="outlined"
                disabled={acting || !u.allowlisted}
                onClick={() => {
                  handleAction("restart").catch(() => {});
                }}
              >
                {pendingAction === "restart" ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5 mr-1" />
                )}
                Restart
              </Button>
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
                      { key: "Load", value: u.load },
                      { key: "Active", value: u.active },
                      { key: "Sub", value: u.sub },
                      { key: "Enabled at boot", value: u.enabled ? "yes" : "no" },
                    ]}
                  />
                </FCard>
              </div>
            ),
          },
          {
            key: "logs",
            label: "Journal",
            children: (
              <div className="pt-4">
                <FCard className="p-4">{logsPanel}</FCard>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
