import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScrollText, ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { Drawer, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { FCard } from "@/components/fable";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { KeyValueList } from "@/components/KeyValueList";
import { api, callVerifyAudit } from "@/lib/api/client";
import { useT } from "@/hooks/useT";
import type { AuditEntry } from "@/mocks/types";
import { relativeTime } from "@/lib/format";

export function AuditPage() {
  const t = useT();
  const {
    data: items = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["audit"],
    queryFn: api.audit,
  });
  const { data: chainResult, isLoading: chainLoading } = useQuery({
    queryKey: ["audit", "verify"],
    queryFn: () => callVerifyAudit({ data: {} }),
    // Verify on mount and re-run every 5 minutes. refetchInterval drives the
    // periodic re-check; staleTime alone never refetches.
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const [sel, setSel] = useState<AuditEntry | null>(null);

  const cols: Column<AuditEntry>[] = [
    {
      key: "created_at",
      header: "When",
      sort: (r) => r.created_at,
      cell: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.created_at)}</span>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      sort: (r) => r.actor,
      cell: (r) => <code className="text-xs">{r.actor}</code>,
    },
    {
      key: "tool",
      header: "Tool",
      cell: (r) => <code className="text-xs">{r.tool}</code>,
    },
    {
      key: "class",
      header: "Class",
      cell: (r) => <Tag variant="outlined">{r.tool_class}</Tag>,
    },
    {
      key: "decision",
      header: "Decision",
      sort: (r) => r.decision,
      cell: (r) => (
        <Tag variant="outlined" color={r.decision === "allow" ? "green" : "red"}>
          {r.decision}
        </Tag>
      ),
    },
    {
      key: "result",
      header: "Result",
      cell: (r) => <span className="text-xs">{r.result}</span>,
    },
    {
      key: "act",
      header: "",
      cell: (r) => (
        <button onClick={() => setSel(r)} className="text-xs text-primary hover:underline">
          view
        </button>
      ),
    },
  ];

  const chainBadge = () => {
    if (chainLoading) {
      return (
        <Tag variant="outlined">
          <Loader2 className="size-3 mr-1 animate-spin" />
          Verifying chain…
        </Tag>
      );
    }
    if (!chainResult) return null;
    if (chainResult.ok) {
      return (
        <Tag variant="outlined" color="green">
          <ShieldCheck className="size-3 mr-1" />
          chain valid ({chainResult.count})
        </Tag>
      );
    }
    return (
      <Tag variant="outlined" color="red">
        <ShieldAlert className="size-3 mr-1" />
        chain broken at #{chainResult.brokenAt.id}
      </Tag>
    );
  };

  let description: string;
  if (isLoading) description = "Loading…";
  else if (isError) description = "Error loading audit log";
  else description = `${items.length} entries · hash-chained`;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ScrollText className="size-5" />}
        title={t.nav.audit}
        description={description}
        actions={chainBadge()}
      />
      {isError ? (
        <p className="text-sm text-destructive">Failed to load audit log. Please try again.</p>
      ) : (
        <FCard className="p-3">
          <DataTable
            columns={cols}
            initialSort="created_at"
            initialSortDir="desc"
            loading={isLoading}
            server={{ queryKey: ["audit", "list"], fetch: api.auditList }}
            empty={
              <EmptyState
                icon={<ScrollText className="size-6" />}
                title="No audit entries"
                description="Privileged actions and policy decisions will be recorded here as they happen."
              />
            }
          />
        </FCard>
      )}
      <Drawer open={!!sel} onClose={() => setSel(null)} title="Audit entry" width={448}>
        {sel && (
          <KeyValueList
            items={[
              { key: "ID", value: sel.id },
              { key: "Actor", value: sel.actor },
              { key: "Tool", value: sel.tool },
              { key: "Class", value: sel.tool_class },
              { key: "Decision", value: sel.decision },
              { key: "Reason", value: sel.decision_reason },
              { key: "Result", value: sel.result },
              { key: "Hash", value: <span className="text-[11px]">{sel.args_hash}</span> },
              { key: "Time", value: sel.created_at },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
}
