import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Play, Square, RotateCw, Server, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Button, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
// ponytail: lobehub Switch API mismatch — @lobehub/ui has no top-level Switch export; keep shadcn Switch.
import { Switch } from "@/components/ui/switch";
import { TableSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { api, callSystemdAction, callMintApproval } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import type { SystemdUnit } from "@/mocks/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Approval-gated systemd action helper (mirrors Docker.tsx / admin/rpc.ts)
// ---------------------------------------------------------------------------

/**
 * Mint an approval token then dispatch the systemd action.
 * The gate (`approval: true`) reads `x-cortex-approval-token` from the
 * request header; we pass it alongside the CSRF header so both checks pass.
 */
async function dispatchSystemdAction(
  action: "start" | "stop" | "restart" | "reload" | "enable" | "disable",
  name: string,
): Promise<void> {
  // 1. Mint a single-use approval token for this exact action+name.
  const mint = await callMintApproval({
    data: { action: "systemd.action", payload: { action, name } },
    headers: csrfHeaders(),
  });

  // 2. Dispatch via systemdAction; pass approval token + CSRF as headers.
  await callSystemdAction({
    data: { action, name },
    headers: {
      ...csrfHeaders(),
      "x-cortex-approval-token": mint.token,
    },
  });
}

export function SystemdPage() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();

  const {
    data: units = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["systemd", "units"],
    queryFn: api.systemd,
    refetchInterval: 15_000,
  });

  const isAdmin = !!user?.is_admin;
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["systemd", "units"] }).catch(() => {});
  };

  const handleAction = async (
    action: "start" | "stop" | "restart" | "reload" | "enable" | "disable",
    unit: SystemdUnit,
  ) => {
    const key = `${action}-${unit.name}`;
    setPendingAction(key);
    try {
      await dispatchSystemdAction(action, unit.name);
      toast.success(`${unit.name}: ${action} dispatched`);
      invalidate();
    } catch {
      toast.error(`Failed to ${action} ${unit.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const cols: Column<SystemdUnit>[] = [
    {
      key: "name",
      header: "Unit",
      sort: (r) => r.name,
      cell: (r) => (
        <Link
          to="/systemd/$unit"
          params={{ unit: r.name }}
          className="font-mono text-xs hover:underline"
        >
          {r.name}
        </Link>
      ),
    },
    {
      key: "desc",
      header: "Description",
      sort: (r) => r.description,
      cell: (r) => <span className="text-sm">{r.description}</span>,
    },
    {
      key: "load",
      header: "Load",
      cell: (r) => <Tag variant="outlined">{r.load}</Tag>,
    },
    {
      key: "active",
      header: "Active",
      sort: (r) => r.active,
      cell: (r) => (
        <Tag
          variant="outlined"
          className={cn(
            r.active === "active" && "border-[var(--success)] text-[var(--success)]",
            r.active === "failed" && "border-[var(--destructive)] text-[var(--destructive)]",
          )}
        >
          {r.active}
        </Tag>
      ),
    },
    {
      key: "sub",
      header: "Sub",
      cell: (r) => <span className="text-xs text-muted-foreground">{r.sub}</span>,
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (r) => {
        const isActing =
          pendingAction === `enable-${r.name}` || pendingAction === `disable-${r.name}`;
        return (
          <Switch
            checked={r.enabled}
            disabled={!isAdmin || isActing || !r.allowlisted}
            onCheckedChange={(v) => {
              handleAction(v ? "enable" : "disable", r).catch(() => {});
            }}
          />
        );
      },
    },
    {
      key: "act",
      header: "",
      className: "text-right",
      cell: (r) => {
        const startKey = `start-${r.name}`;
        const stopKey = `stop-${r.name}`;
        const restartKey = `restart-${r.name}`;
        const isActing =
          pendingAction === startKey || pendingAction === stopKey || pendingAction === restartKey;
        return (
          <div className="flex justify-end gap-1">
            {r.active !== "active" ? (
              <Button
                size="small"
                type="text"
                disabled={!isAdmin || isActing || !r.allowlisted}
                onClick={() => {
                  handleAction("start", r).catch(() => {});
                }}
                title="Start"
              >
                {pendingAction === startKey ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </Button>
            ) : (
              <Button
                size="small"
                type="text"
                disabled={!isAdmin || isActing || !r.allowlisted}
                onClick={() => {
                  handleAction("stop", r).catch(() => {});
                }}
                title="Stop"
              >
                {pendingAction === stopKey ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
              </Button>
            )}
            <Button
              size="small"
              type="text"
              disabled={!isAdmin || isActing || !r.allowlisted}
              onClick={() => {
                handleAction("restart", r).catch(() => {});
              }}
              title="Restart"
            >
              {pendingAction === restartKey ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCw className="size-3.5" />
              )}
            </Button>
          </div>
        );
      },
    },
  ];

  let tablePanel;
  if (isLoading) {
    tablePanel = <TableSkeleton rows={8} cols={7} />;
  } else if (isError) {
    tablePanel = (
      <EmptyState
        title="Failed to load units"
        description="Could not read systemd unit list. Check that systemd is available on the host."
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
    );
  } else {
    tablePanel = (
      <DataTable
        columns={cols}
        initialSort="name"
        server={{ queryKey: ["systemd", "units"], fetch: api.systemdList }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Server className="size-5" />}
        title={t.nav.systemd}
        description={`${units.length} units · ${units.filter((u) => u.active === "active").length} active`}
      />

      {tablePanel}
    </div>
  );
}
