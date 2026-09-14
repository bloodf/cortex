import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Cpu, List, Network, Search, Skull } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usageBg, usageColor } from "@/lib/status";
import { cn } from "@/lib/utils";
import { FCard, FToolbar } from "@/components/fable";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/skeletons";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { api, callKillProcess, callMintApproval } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import type { ProcessInfo } from "@/lib/api/client";

type View = "list" | "tree";

function TreeGroup({
  group,
}: {
  group: { user: string; items: ProcessInfo[]; cpu: number; mem: number };
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 text-sm"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
        <span className="font-medium">{group.user}</span>
        <span className="text-xs text-muted-foreground">
          {group.items.length} proc{group.items.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground tabular-nums">
          CPU {group.cpu.toFixed(1)}% · MEM {group.mem.toFixed(1)}%
        </span>
      </button>
      {open && (
        <ul className="bg-background/40">
          {group.items.map((p) => (
            <li
              key={p.pid}
              className="grid grid-cols-[80px_1fr_120px_120px] items-center gap-3 px-3 py-1.5 pl-9 text-xs hover:bg-muted/30 border-t"
            >
              <span className="font-mono tabular-nums text-muted-foreground">{p.pid}</span>
              <span className="font-mono truncate" title={p.command}>
                {p.command}
              </span>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full transition-all", usageBg(p.cpu))}
                    style={{ width: `${Math.min(100, p.cpu)}%` }}
                  />
                </div>
                <span className={cn("tabular-nums", usageColor(p.cpu))}>{p.cpu.toFixed(1)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full transition-all", usageBg(p.mem))}
                    style={{ width: `${Math.min(100, p.mem)}%` }}
                  />
                </div>
                <span className={cn("tabular-nums", usageColor(p.mem))}>{p.mem.toFixed(1)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeView({
  procs,
  loading,
  q,
  onQ,
}: {
  procs: ProcessInfo[];
  loading: boolean;
  q: string;
  onQ: (v: string) => void;
}) {
  const t = useT();
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, ProcessInfo[]>();
    procs.forEach((p) => {
      if (
        needle &&
        !(
          p.command.toLowerCase().includes(needle) ||
          p.user.includes(needle) ||
          String(p.pid).includes(needle)
        )
      ) {
        return;
      }
      const arr = map.get(p.user) ?? [];
      arr.push(p);
      map.set(p.user, arr);
    });
    return [...map.entries()]
      .map(([user, items]) => ({
        user,
        items: items.sort((a, b) => b.cpu - a.cpu),
        cpu: items.reduce((s, x) => s + x.cpu, 0),
        mem: items.reduce((s, x) => s + x.mem, 0),
      }))
      .sort((a, b) => b.cpu - a.cpu);
  }, [procs, q]);

  if (loading) return <TableSkeleton rows={10} cols={5} />;

  return (
    <div className="space-y-3">
      <FToolbar>
        <div className="relative max-w-md flex-1">
          <Input
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder="Filter by command, user or pid…"
            prefix={<Search className="size-4 text-muted-foreground" aria-hidden />}
            className="h-9"
          />
        </div>
      </FToolbar>

      {groups.length === 0 ? (
        <FCard>
          <EmptyState
            icon={<Cpu className="size-7" />}
            title={t.empty.processes.emptyTitle}
            description={t.empty.processes.emptyDescription}
          />
        </FCard>
      ) : (
        <FCard className="overflow-hidden divide-y">
          {groups.map((g) => (
            <TreeGroup key={g.user} group={g} />
          ))}
        </FCard>
      )}
    </div>
  );
}

export function ProcessesPage() {
  const t = useT();
  const {
    data: procs = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["processes"],
    queryFn: api.processes,
    refetchInterval: 3000,
  });
  const [view, setView] = useState<View>("list");
  const [q, setQ] = useState("");

  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const killMut = useMutation({
    mutationFn: async (vars: { pid: number; signal: "SIGTERM" | "SIGKILL" }) => {
      // Mint a single-use approval token bound to action `processes.kill` with
      // the same input the pipeline hashes ({ pid, signal }), then dispatch with
      const mint = await callMintApproval({
        data: { action: "processes.kill", payload: { pid: vars.pid, signal: vars.signal } },
        headers: csrfHeaders(),
      });
      return callKillProcess({
        data: vars,
        headers: { ...csrfHeaders(), "x-cortex-approval-token": mint.token },
      });
    },
    onSuccess: (_d, vars) => {
      toast.success(`Sent ${vars.signal} to PID ${vars.pid}`);
      qc.invalidateQueries({ queryKey: ["processes"] }).catch(() => {});
    },
    onError: (e: Error) => toast.error(e.message || "Failed to signal process"),
  });

  const cols: Column<ProcessInfo>[] = [
    {
      key: "pid",
      header: "PID",
      sort: (r) => r.pid,
      className: "tabular-nums w-20",
      cell: (r) => <span className="font-mono">{r.pid}</span>,
    },
    {
      key: "user",
      header: "User",
      sort: (r) => r.user,
      cell: (r) => <span className="text-sm">{r.user}</span>,
    },
    {
      key: "cmd",
      header: "Command",
      cell: (r) => (
        <span className="font-mono text-xs truncate block max-w-[420px]">{r.command}</span>
      ),
    },
    {
      key: "cpu",
      header: "CPU %",
      sort: (r) => r.cpu,
      className: "w-44",
      cell: (r) => (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", usageBg(r.cpu))}
              style={{ width: `${Math.min(100, r.cpu)}%` }}
            />
          </div>
          <span className={cn("tabular-nums text-xs", usageColor(r.cpu))}>{r.cpu.toFixed(1)}</span>
        </div>
      ),
    },
    {
      key: "mem",
      header: "MEM %",
      sort: (r) => r.mem,
      className: "w-44",
      cell: (r) => (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", usageBg(r.mem))}
              style={{ width: `${Math.min(100, r.mem)}%` }}
            />
          </div>
          <span className={cn("tabular-nums text-xs", usageColor(r.mem))}>{r.mem.toFixed(1)}</span>
        </div>
      ),
    },
  ];

  if (isAdmin) {
    cols.push({
      key: "actions",
      header: "",
      className: "text-right w-24",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <ConfirmDialog
            trigger={
              <Button size="small" type="text" aria-label={`Terminate PID ${r.pid}`}>
                <Ban className="size-3.5 text-[var(--warning)]" />
              </Button>
            }
            title={`Terminate PID ${r.pid}?`}
            description={`Send SIGTERM to "${r.command}" (user ${r.user}).`}
            confirmLabel="Send SIGTERM"
            onConfirm={() => killMut.mutate({ pid: r.pid, signal: "SIGTERM" })}
          />
          <ConfirmDialog
            trigger={
              <Button size="small" type="text" aria-label={`Force kill PID ${r.pid}`}>
                <Skull className="size-3.5 text-destructive" />
              </Button>
            }
            title={`Force kill PID ${r.pid}?`}
            description={`Send SIGKILL to "${r.command}" (user ${r.user}). This cannot be caught or ignored.`}
            destructive
            confirmLabel="Send SIGKILL"
            onConfirm={() => killMut.mutate({ pid: r.pid, signal: "SIGKILL" })}
          />
        </div>
      ),
    });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Cpu className="size-5" />}
        title={t.nav.processes}
        description={`${procs.length} processes`}
        actions={
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            <Button
              htmlType="button"
              size="small"
              type={view === "list" ? "default" : "text"}
              className="h-7 px-2 text-xs gap-1.5"
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
            >
              <List className="size-3.5" /> List
            </Button>
            <Button
              htmlType="button"
              size="small"
              type={view === "tree" ? "default" : "text"}
              className="h-7 px-2 text-xs gap-1.5"
              onClick={() => setView("tree")}
              aria-pressed={view === "tree"}
            >
              <Network className="size-3.5" /> Tree
            </Button>
          </div>
        }
      />

      {isError && (
        <EmptyState
          icon={<Cpu className="size-6" />}
          title="Couldn't load processes"
          description="The request failed — it will retry automatically."
        />
      )}

      {view === "list" ? (
        <DataTable
          rows={procs}
          columns={cols}
          loading={isLoading}
          initialSort="cpu"
          filterFn={(r, query) =>
            r.command.toLowerCase().includes(query) ||
            r.user.includes(query) ||
            String(r.pid).includes(query)
          }
        />
      ) : (
        <TreeView procs={procs} loading={isLoading} q={q} onQ={setQ} />
      )}
    </div>
  );
}
