import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  Plus,
  Boxes,
  Loader2,
  CheckCircle2,
  Play,
  Square,
  RotateCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button, Drawer, Input, Modal, Select, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { KeyValueList } from "@/components/KeyValueList";
import { CodeBlock } from "@/components/CodeBlock";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TableSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { FLabel, FTerminal } from "@/components/fable";
import { api, callIncusAction, callMintApproval } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import type { IncusInstance } from "@/mocks/types";
import { bytes, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Approval-gated incus action helper (mirrors Docker.tsx pattern)
// ---------------------------------------------------------------------------

/**
 * Mint an approval token then dispatch the incus action.
 * Destructive actions (stop/restart/delete) require a valid token bound to
 * the current session (PB-5). Non-destructive actions (start/launch) still
 * go through mintApproval so the bridge's approval gate is satisfied.
 */
async function dispatchIncusAction(
  action: "start" | "stop" | "restart" | "delete" | "launch",
  name: string,
  confirmation?: string,
): Promise<void> {
  // PB-5: bridge uses actionHashFor('incus.'+action, { name }) — payload must
  // contain `{ name }` only. See src/server/incus/bridge.ts:1196,1474.
  const mint = await callMintApproval({
    data: { action: `incus.${action}`, payload: { name } },
    headers: csrfHeaders(),
  });
  await callIncusAction({
    data: { action, name, confirmation, approvalToken: mint.token },
    headers: csrfHeaders(),
  });
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

function ProvisionWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("hermes-canary");
  const [image, setImage] = useState("ubuntu/24.04");
  const [cpu, setCpu] = useState(2);
  const [mem, setMem] = useState(4096);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [launching, setLaunching] = useState(false);

  const appendLog = (msg: string) => setLog((l) => [...l, msg]);

  const start = async () => {
    setStep(4);
    setLog([]);
    setDone(false);
    setLaunching(true);

    appendLog(`Preflight: validating name "${name}"…`);
    appendLog(`Preflight: checking image cache for ${image}…`);
    appendLog(`Launching ${image} as ${name} (cpu=${cpu}, mem=${mem}MiB)…`);

    try {
      // Approval is bound to `{ name }` only (PB-5) — the bridge hashes
      // actionHashFor('incus.launch', { name }). The mint payload MUST match
      // that shape exactly or the hashes diverge and the launch is rejected.
      const mint = await callMintApproval({
        data: { action: "incus.launch", payload: { name } },
        headers: csrfHeaders(),
      });
      appendLog("Approval token minted.");
      await callIncusAction({
        data: { action: "launch", name, image, cpu, memory: mem, approvalToken: mint.token },
        headers: csrfHeaders(),
      });
      appendLog("Instance launched");
      setDone(true);
      onCreated();
    } catch (err) {
      appendLog(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLaunching(false);
    }
  };

  const reset = () => {
    setStep(0);
    setLog([]);
    setDone(false);
    setLaunching(false);
  };

  return (
    <Modal
      open={open}
      onCancel={() => {
        onOpenChange(false);
        reset();
      }}
      title="Provision Incus instance"
      footer={
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Step {Math.min(step + 1, 5)} of 5</p>
          <div className="flex justify-end gap-2">
            {step > 0 && step < 4 && (
              <Button variant="outlined" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            {step < 3 && (
              <Button type="primary" onClick={() => setStep(step + 1)}>
                Next
              </Button>
            )}
            {step === 3 && (
              <Button type="primary" onClick={start} disabled={!name.trim()}>
                Provision
              </Button>
            )}
            {step === 4 && done && (
              <Button
                type="primary"
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                Done
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="max-w-lg">
        {step === 0 && (
          <div className="space-y-3">
            <FLabel>Name</FLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        {step === 1 && (
          <div className="space-y-3">
            <FLabel>Image</FLabel>
            <Select
              className="w-full"
              value={image}
              onChange={setImage}
              options={[
                { value: "ubuntu/24.04", label: "ubuntu/24.04" },
                { value: "debian/12", label: "debian/12" },
                { value: "alpine/3.20", label: "alpine/3.20" },
              ]}
            />
          </div>
        )}
        {step === 2 && (
          <div className="space-y-3">
            <FLabel>CPU cores</FLabel>
            <Input type="number" value={cpu} onChange={(e) => setCpu(+e.target.value)} />
          </div>
        )}
        {step === 3 && (
          <div className="space-y-3">
            <FLabel>Memory (MiB)</FLabel>
            <Input type="number" value={mem} onChange={(e) => setMem(+e.target.value)} />
          </div>
        )}
        {step === 4 && (
          <div className="space-y-2">
            <FTerminal className="h-48">
              {log.map((l, i) => (
                <div key={i} className="flex gap-2">
                  {launching && i === log.length - 1 ? (
                    <Loader2 className="size-3 animate-spin text-primary mt-0.5" />
                  ) : (
                    <span className="text-muted-foreground">›</span>
                  )}
                  {l}
                </div>
              ))}
              {done && (
                <div className="flex items-center gap-2 text-[var(--success)] mt-2">
                  <CheckCircle2 className="size-4" /> Provisioning complete
                </div>
              )}
            </FTerminal>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function IncusPage() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { isLoading, isError } = useQuery({
    queryKey: ["incus"],
    queryFn: api.incus,
    refetchInterval: 15_000,
  });
  const [active, setActive] = useState<IncusInstance | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const isAdmin = !!user?.is_admin;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["incus"] }).catch(() => {});
  };

  const incusAction = async (
    action: "start" | "stop" | "restart" | "delete" | "launch",
    successVerb: string,
    errorVerb: string,
    inst: IncusInstance,
    dispatchAction?: string,
  ) => {
    const key = `${action}-${inst.name}`;
    setPendingAction(key);
    try {
      await dispatchIncusAction(action, inst.name, dispatchAction);
      toast.success(`${successVerb} ${inst.name}`);
      invalidate();
    } catch {
      toast.error(`Failed to ${errorVerb} ${inst.name}`);
    } finally {
      setPendingAction(null);
    }
  };

  const cols: Column<IncusInstance>[] = [
    {
      key: "project",
      header: "Project",
      sort: (r) => r.project.name,
      cell: (r) => (
        <div className="min-w-0">
          <Link
            to="/incus/$name"
            params={{ name: r.name }}
            className="font-medium hover:underline truncate block"
          >
            {r.project.name}
          </Link>
          <p className="text-[11px] text-muted-foreground truncate">{r.project.description}</p>
        </div>
      ),
    },
    {
      key: "name",
      header: "Instance",
      sort: (r) => r.name,
      cell: (r) => <code className="text-xs">{r.name}</code>,
    },
    {
      key: "type",
      header: "Type",
      sort: (r) => r.type,
      cell: (r) => <Tag variant="outlined">{r.type}</Tag>,
    },
    {
      key: "image",
      header: "Image",
      cell: (r) => <code className="text-xs">{r.image}</code>,
    },
    {
      key: "cpu",
      header: "CPU",
      className: "text-right tabular-nums",
      cell: (r) => (r.cpu === null ? "—" : `${r.cpu}`),
    },
    {
      key: "memory",
      header: "Memory",
      className: "text-right tabular-nums",
      cell: (r) => (r.memory === null ? "—" : bytes(r.memory * 1024 * 1024)),
    },
    {
      key: "status",
      header: "Status",
      sort: (r) => r.status,
      cell: (r) => (
        <Tag variant="outlined" className={cn(statusColors[r.status] ?? "")}>
          {r.status}
        </Tag>
      ),
    },
    {
      key: "act",
      header: "",
      className: "text-right",
      cell: (r) => {
        const acting = pendingAction !== null;
        const isRunning = (r.status as string) === "active" || (r.status as string) === "running";
        return (
          <div className="flex gap-1 justify-end">
            <Button
              size="small"
              type="text"
              onClick={() => setActive(r)}
              title="Open details"
              aria-label="Open details"
            >
              <ChevronRight className="size-3.5" />
            </Button>
            {isAdmin && !isRunning && (
              <Button
                size="small"
                type="text"
                disabled={acting}
                onClick={() => incusAction("start", "Started", "start", r)}
                title="Start"
                aria-label="Start"
              >
                {pendingAction === `start-${r.name}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </Button>
            )}
            {isAdmin && isRunning && (
              <Button
                size="small"
                type="text"
                disabled={acting}
                onClick={() => incusAction("stop", "Stopped", "stop", r)}
                title="Stop"
                aria-label="Stop"
              >
                {pendingAction === `stop-${r.name}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
              </Button>
            )}
            {isAdmin && (
              <Button
                size="small"
                type="text"
                disabled={acting}
                onClick={() => incusAction("restart", "Restarted", "restart", r)}
                title="Restart"
                aria-label="Restart"
              >
                {pendingAction === `restart-${r.name}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
              </Button>
            )}
            {isAdmin && (
              <ConfirmDialog
                trigger={
                  <Button
                    size="small"
                    type="text"
                    disabled={acting}
                    className="text-destructive hover:text-destructive"
                    title="Delete"
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                }
                title={`Delete instance ${r.name}?`}
                description="This will permanently delete the instance. This cannot be undone."
                destructive
                requireText={r.name}
                confirmLabel="Delete"
                onConfirm={() => incusAction("delete", "Deleted", "delete", r, "delete")}
              />
            )}
          </div>
        );
      },
    },
  ];

  let tablePanel;
  if (isLoading) {
    tablePanel = <TableSkeleton rows={6} cols={7} />;
  } else if (isError) {
    tablePanel = (
      <EmptyState
        title="Failed to load instances"
        description="Could not reach the Incus bridge. Check that the Incus daemon is running."
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
    );
  } else {
    tablePanel = (
      <DataTable
        columns={cols}
        initialSort="project"
        server={{ queryKey: ["incus"], fetch: api.incusList }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Boxes className="size-5" />}
        title={t.nav.incus}
        description="One project per Incus instance — manage system containers, VMs and the projects they host."
        actions={
          isAdmin ? (
            <Button size="small" type="primary" onClick={() => setWizardOpen(true)}>
              <Plus className="size-4 mr-1" />
              New project / instance
            </Button>
          ) : undefined
        }
      />

      {tablePanel}

      <Drawer
        open={!!active}
        onClose={() => setActive(null)}
        placement="right"
        width="min(100vw, 36rem)"
        title={active ? active.project.name : undefined}
        extra={
          active ? (
            <p className="text-xs text-muted-foreground">{active.project.description}</p>
          ) : undefined
        }
        classNames={{ body: "overflow-y-auto" }}
      >
        {active && (
          <div className="space-y-4">
            <KeyValueList
              items={[
                { key: "Instance", value: <code className="text-xs">{active.name}</code> },
                {
                  key: "Repo",
                  value: active.project.repo_url ? (
                    <a
                      href={active.project.repo_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline text-xs"
                    >
                      {active.project.repo_url.replace("https://", "")}
                    </a>
                  ) : (
                    "—"
                  ),
                },
                {
                  key: "Branch",
                  value: <code className="text-xs">{active.project.branch}</code>,
                },
                { key: "Type", value: active.type },
                { key: "Image", value: active.image },
                {
                  key: "Status",
                  value: (
                    <Tag variant="outlined" className={cn(statusColors[active.status] ?? "")}>
                      {active.status}
                    </Tag>
                  ),
                },
                { key: "CPU", value: active.cpu === null ? "—" : active.cpu },
                {
                  key: "Memory",
                  value: active.memory === null ? "—" : bytes(active.memory * 1024 * 1024),
                },
                { key: "Created", value: relativeTime(active.created_at) },
              ]}
            />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Devices</p>
              <CodeBlock
                language="yaml"
                code={Object.entries(active.devices)
                  .map(
                    ([k, v]) =>
                      `${k}:\n${Object.entries(v)
                        .map(([kk, vv]) => `  ${kk}: ${vv}`)
                        .join("\n")}`,
                  )
                  .join("\n")}
              />
            </div>
          </div>
        )}
      </Drawer>

      <ProvisionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => {
          invalidate();
          toast.success("Instance provisioned");
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provision wizard — wired to incusAction(launch) via mintApproval
// ---------------------------------------------------------------------------
