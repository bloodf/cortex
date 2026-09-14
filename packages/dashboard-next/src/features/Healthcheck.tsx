import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { RefreshCw, HeartPulse } from "lucide-react";
import { toast } from "sonner";
import { Button, Tabs } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { TechIcon } from "@/components/TechIcon";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { IncidentTimeline } from "@/components/IncidentTimeline";
import { FCard, FCardHeader } from "@/components/fable";
import { LogStream } from "@/components/LogStream";
import { api, callHostLogs } from "@/lib/api/client";
import type { Service } from "@/lib/api/client";
import { recheckServiceHealth } from "@/lib/api/services.functions";
import { useT } from "@/hooks/useT";
import { ms } from "@/lib/format";

export function HealthcheckPage() {
  const t = useT();
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<"1h" | "24h" | "7d">("24h");

  const search = location.search as { tab?: string };
  const activeTab = search.tab === "logs" ? "logs" : "health";

  const {
    data: history = [],
    isLoading: historyLoading,
    isError: historyError,
  } = useQuery({
    queryKey: ["alerts", "history"],
    queryFn: api.alerts.history,
    refetchInterval: 30_000,
  });

  const setTab = useCallback(
    (value: string) => {
      navigate({ search: { tab: value } } as never);
    },
    [navigate],
  );

  // MP-009: live host-journal line fetcher. `callHostLogs` is admin-only,
  // so non-admin users see an empty stream. Errors PROPAGATE so
  // LogStream's polling effect can catch them and keep the previously
  // rendered lines on screen (the 401/403 audit trail lives on the
  // server; the gate also runs a 10/min/user rate-limit and
  // audit-logs every call).
  const fetchHostLogs = useCallback(async (): Promise<string[]> => {
    const { lines } = await callHostLogs({ data: { limit: 200 } });
    return lines.map((l) => `[${l.ts}] ${l.priority.padEnd(7)} ${l.unit}: ${l.message}`);
  }, []);

  const recheck = async (row: Service) => {
    toast.info(`Re-checking ${row.name}…`);
    try {
      const recheckFn = recheckServiceHealth as unknown as (opts: {
        data: { id: number; source: "manual" };
      }) => Promise<unknown>;
      await recheckFn({ data: { id: row.id, source: "manual" } });
      await qc.invalidateQueries({ queryKey: ["healthcheck"] });
      toast.success(`${row.name} probe complete`);
    } catch {
      toast.error(`Re-check failed for ${row.name}`);
    }
  };

  const cols: Column<Service>[] = [
    {
      key: "name",
      header: "Service",
      sort: (r) => r.name,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <TechIcon slug={r.slug} name={r.name} size={24} />
          <div className="min-w-0">
            <p className="font-medium truncate">{r.name}</p>
            <p className="text-[11px] text-muted-foreground font-mono truncate">{r.health_url}</p>
          </div>
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      sort: (r) => r.category,
      cell: (r) => <span className="text-xs">{r.category}</span>,
    },
    {
      key: "status",
      header: "Status",
      sort: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "rt",
      header: "Latency",
      sort: (r) => r.responseTime,
      className: "text-right tabular-nums",
      cell: (r) => (r.responseTime > 0 ? ms(r.responseTime) : "—"),
    },
    {
      key: "type",
      header: "Type",
      sort: (r) => r.health_type,
      cell: (r) => <span className="text-xs font-mono">{r.health_type}</span>,
    },
    {
      key: "act",
      header: "",
      cell: (r) => (
        <Button size="small" type="text" onClick={() => recheck(r)}>
          <RefreshCw className="size-3.5" />
        </Button>
      ),
      className: "text-right w-[60px]",
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.nav.healthcheck}
        description="Periodic probes across all registered services."
        actions={
          <div className="flex gap-1 border rounded-md p-0.5 bg-muted/30">
            {(["1h", "24h", "7d"] as const).map((p) => (
              <Button
                key={p}
                size="small"
                type={period === p ? "primary" : "text"}
                className="h-7 px-3"
                onClick={() => setPeriod(p)}
              >
                {p}
              </Button>
            ))}
          </div>
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={setTab}
        items={[
          {
            key: "health",
            label: "Health",
            children: (
              <div className="mt-4 space-y-5">
                <DataTable
                  columns={cols}
                  initialSort="status"
                  server={{
                    queryKey: ["healthcheck"],
                    fetch: api.healthcheckList,
                    refetchInterval: 3000,
                  }}
                  empty={
                    <EmptyState
                      icon={<HeartPulse className="size-6" />}
                      title="No services to monitor"
                      description="Health checks will appear here once services are registered."
                    />
                  }
                />

                <FCard>
                  <FCardHeader title="Incident timeline" />
                  <div className="p-4">
                    {historyError ? (
                      <EmptyState
                        title="Couldn't load incident history"
                        description="The request failed — it will retry automatically."
                      />
                    ) : historyLoading ? (
                      <p className="text-xs text-muted-foreground">Loading alert history…</p>
                    ) : (
                      <IncidentTimeline items={history.slice(0, 20)} />
                    )}
                  </div>
                </FCard>
              </div>
            ),
          },
          {
            key: "logs",
            label: "Logs",
            children: (
              <div className="mt-4">
                <FCard>
                  <FCardHeader title="Live log stream" />
                  <div className="p-4">
                    <LogStream height={360} fetcher={fetchHostLogs} refetchIntervalMs={3000} />
                  </div>
                </FCard>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
