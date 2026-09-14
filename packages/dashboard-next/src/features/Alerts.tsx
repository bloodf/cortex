import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Button, Tabs, Tag } from "@lobehub/ui";
import { Switch } from "@lobehub/ui/base-ui";
import { PageHeader } from "@/components/PageHeader";
import { FCard } from "@/components/fable";
import { DataTable, type Column } from "@/components/DataTable";
import { IncidentTimeline } from "@/components/IncidentTimeline";
import { TableSkeleton, CardSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api/client";
import { useT } from "@/hooks/useT";
import type { AlertRule, AlertHistory } from "@/mocks/types";
import { relativeTime } from "@/lib/format";

export function AlertsPage() {
  const t = useT();
  const qc = useQueryClient();

  const {
    data: rules = [],
    isLoading: lr,
    isError: er,
  } = useQuery({
    queryKey: ["alerts", "rules"],
    queryFn: api.alerts.rules,
    refetchInterval: 30_000,
  });

  const {
    data: history = [],
    isLoading: lh,
    isError: eh,
  } = useQuery({
    queryKey: ["alerts", "history"],
    queryFn: api.alerts.history,
    refetchInterval: 30_000,
  });

  const firingCount = history.filter((h) => h.status === "fired").length;

  const ruleCols: Column<AlertRule>[] = [
    {
      key: "name",
      header: "Rule",
      sort: (r) => r.name,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "cond",
      header: "Condition",
      cell: (r) => (
        <code className="text-xs">
          {r.condition}
          {r.threshold_ms ? ` · ${r.threshold_ms}ms` : ""}
        </code>
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (r) => <Switch checked={r.enabled} disabled />,
    },
  ];

  const histCols: Column<AlertHistory>[] = [
    {
      key: "timestamp",
      header: "When",
      sort: (r) => r.timestamp,
      cell: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.timestamp)}</span>
      ),
    },
    {
      key: "ruleName",
      header: "Rule",
      sort: (r) => r.ruleName,
      cell: (r) => <span className="font-medium">{r.ruleName}</span>,
    },
    {
      key: "svc",
      header: "Service",
      cell: (r) => r.serviceName,
    },
    {
      key: "msg",
      header: "Message",
      cell: (r) => <span className="text-xs">{r.message}</span>,
    },
    {
      key: "status",
      header: "Status",
      sort: (r) => r.status,
      cell: (r) => (
        <Tag
          variant="outlined"
          color={r.status === "fired" ? "red" : r.status === "resolved" ? "green" : undefined}
        >
          {r.status}
        </Tag>
      ),
    },
  ];

  let timelinePanel: React.ReactNode;
  if (lh) {
    timelinePanel = <CardSkeleton lines={5} />;
  } else if (eh) {
    timelinePanel = (
      <EmptyState
        title="Failed to load alert history"
        description="Could not reach the alerts service."
        action={
          <Button
            size="small"
            variant="outlined"
            onClick={() => qc.invalidateQueries({ queryKey: ["alerts", "history"] })}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (history.length === 0) {
    timelinePanel = (
      <EmptyState
        title="No incidents recorded"
        description="Alert firings will appear here once rules trigger."
      />
    );
  } else {
    timelinePanel = (
      <FCard className="p-5">
        <IncidentTimeline items={history} />
      </FCard>
    );
  }

  let historyPanel: React.ReactNode;
  if (lh) {
    historyPanel = <TableSkeleton rows={8} cols={5} />;
  } else if (eh) {
    historyPanel = (
      <EmptyState
        title="Failed to load history"
        description="Could not reach the alerts service."
        action={
          <Button
            size="small"
            variant="outlined"
            onClick={() => qc.invalidateQueries({ queryKey: ["alerts", "history"] })}
          >
            Retry
          </Button>
        }
      />
    );
  } else {
    historyPanel = (
      <DataTable
        columns={histCols}
        initialSort="timestamp"
        initialSortDir="desc"
        server={{
          queryKey: ["alerts", "history"],
          fetch: api.alerts.historyList,
          refetchInterval: 30_000,
        }}
      />
    );
  }

  let rulesPanel: React.ReactNode;
  if (lr) {
    rulesPanel = <TableSkeleton rows={5} cols={3} />;
  } else if (er) {
    rulesPanel = (
      <EmptyState
        title="Failed to load rules"
        description="Could not reach the alerts service."
        action={
          <Button
            size="small"
            variant="outlined"
            onClick={() => qc.invalidateQueries({ queryKey: ["alerts", "rules"] })}
          >
            Retry
          </Button>
        }
      />
    );
  } else {
    rulesPanel = (
      <DataTable
        columns={ruleCols}
        initialSort="name"
        server={{ queryKey: ["alerts", "rules"], fetch: api.alerts.rulesList }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Bell className="size-5" />}
        title={t.nav.alerts}
        description={`${rules.length} rules · ${firingCount} firing`}
      />
      <Tabs
        defaultActiveKey="timeline"
        items={[
          {
            key: "timeline",
            label: "Timeline",
            children: <div className="mt-4">{timelinePanel}</div>,
          },
          {
            key: "history",
            label: "History",
            children: <div className="mt-4">{historyPanel}</div>,
          },
          { key: "rules", label: "Rules", children: <div className="mt-4">{rulesPanel}</div> },
        ]}
      />
    </div>
  );
}
