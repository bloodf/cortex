import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  MessageSquare,
  Pause,
  PlayCircle,
  Power,
  RotateCw,
  Search,
  Upload,
} from "lucide-react";
import { useNavigate, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button, Input, Modal, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { CodeBlock } from "@/components/CodeBlock";
import { EmptyState } from "@/components/EmptyState";
import { FCard, FToolbar } from "@/components/fable";
import { CardSkeleton } from "@/components/skeletons";
import {
  api,
  uploadAgentFile,
  readAgentFiles,
  callAgentAction,
  callMintApproval,
} from "@/lib/api/client";
import type { AgentFile } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { APPROVAL_ACTIONS } from "@/lib/api/approval-actions";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import type { Agent, AgentHealth, AgentRunState } from "@/mocks/types";

const STATE_TONE: Record<AgentRunState, string> = {
  running: "bg-[var(--success)]",
  idle: "bg-[var(--muted-foreground)]",
  stopped: "bg-muted-foreground/50",
  error: "bg-[var(--destructive)]",
};

const STATE_DOT: Record<AgentRunState, "ok" | "off" | "err"> = {
  running: "ok",
  idle: "off",
  stopped: "off",
  error: "err",
};

const HEALTH_LABEL: Record<AgentHealth, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const HEALTH_TONE: Record<AgentHealth, string> = {
  healthy: "text-[var(--success)] border-[var(--success)]/30 bg-[var(--success)]/10",
  degraded: "text-[var(--warning)] border-[var(--warning)]/30 bg-[var(--warning)]/10",
  down: "text-[var(--destructive)] border-[var(--destructive)]/30 bg-[var(--destructive)]/10",
  unknown: "text-muted-foreground border-muted-foreground/30 bg-muted/40",
};

function errorRateClass(pct: number): string {
  if (pct >= 5) return "text-[var(--destructive)]";
  if (pct >= 1) return "text-[var(--warning)]";
  return "";
}

function formatUptime(sec: number) {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Inspect dialog — renders real HermesProfile config + file upload for admins
// ---------------------------------------------------------------------------

/** Profile fields rendered as YAML-like config block in the dialog. */
function profileYaml(agent: Agent): string {
  const lines: string[] = [
    `profile: ${agent.slug}`,
    `model: ${agent.model}`,
    `provider: ${agent.modelProvider}`,
    `state: ${agent.state}`,
    `health: ${agent.health}`,
  ];
  if (agent.description && !agent.description.startsWith("Hermes profile:")) {
    lines.push(`description: "${agent.description}"`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File tree for the Inspect dialog
//
// The server returns a FLAT list of POSIX-relative paths; the dialog shows them
// as a collapsible directory tree so a profile home with 100+ files stays
// navigable instead of overflowing a flat list off-screen.
// ---------------------------------------------------------------------------

interface TreeFile {
  path: string;
}
interface TreeDir {
  name: string;
  /** Full path prefix (POSIX) — used as the collapse key. */
  prefix: string;
  dirs: TreeDir[];
  files: { name: string; path: string }[];
}

/** Build a nested directory tree from flat `dir/sub/file` paths. */
function buildFileTree(files: TreeFile[]): TreeDir {
  const root: TreeDir = { name: "", prefix: "", dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const prefix = node.prefix ? `${node.prefix}/${name}` : name;
      let child = node.dirs.find((d) => d.name === name);
      if (!child) {
        child = { name, prefix, dirs: [], files: [] };
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], path: f.path });
  }
  const sortRec = (d: TreeDir): void => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.name.localeCompare(b.name));
    d.dirs.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function FileTreeNode({
  dir,
  depth,
  activeFile,
  onSelect,
  expanded,
  toggle,
}: {
  dir: TreeDir;
  depth: number;
  activeFile: string;
  onSelect: (path: string) => void;
  expanded: Set<string>;
  toggle: (prefix: string) => void;
}) {
  return (
    <>
      {dir.dirs.map((sub) => {
        const isOpen = expanded.has(sub.prefix);
        return (
          <div key={sub.prefix}>
            <button
              onClick={() => toggle(sub.prefix)}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className="w-full text-left rounded px-2 py-1 text-xs flex items-center gap-1.5 hover:bg-muted/50 font-mono text-muted-foreground"
            >
              {isOpen ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              {isOpen ? (
                <FolderOpen className="size-3 shrink-0" />
              ) : (
                <Folder className="size-3 shrink-0" />
              )}
              <span className="truncate">{sub.name}</span>
            </button>
            {isOpen && (
              <FileTreeNode
                dir={sub}
                depth={depth + 1}
                activeFile={activeFile}
                onSelect={onSelect}
                expanded={expanded}
                toggle={toggle}
              />
            )}
          </div>
        );
      })}
      {dir.files.map((f) => (
        <button
          key={f.path}
          onClick={() => onSelect(f.path)}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className={cn(
            "w-full text-left rounded px-2 py-1 text-xs flex items-center gap-1.5 hover:bg-muted/50 font-mono",
            activeFile === f.path && "bg-accent text-accent-foreground",
          )}
          title={f.path}
        >
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
    </>
  );
}

/** Stable empty fallback so a loading query doesn't churn the file tree. */
const EMPTY_FILES: AgentFile[] = [];

function InspectorBody({ agent, isAdmin }: { agent: Agent; isAdmin: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeFile, setActiveFile] = useState<string>("profile");

  const queryClient = useQueryClient();

  // Recursively read the profile home's config files (admin-only server-fn).
  // Non-admins only ever see the synthesized profile.yaml tab.
  const filesQuery = useQuery({
    queryKey: ["agent-files", agent.slug],
    queryFn: () => readAgentFiles({ data: { slug: agent.slug } }),
    enabled: isAdmin,
    staleTime: 30_000,
  });
  const diskFiles = filesQuery.data?.files ?? EMPTY_FILES;
  const hasDiskFiles = diskFiles.length > 0;
  const fileTree = useMemo(() => buildFileTree(diskFiles), [diskFiles]);
  // Top-level dirs start expanded; reset when switching agents or when the file
  // set changes. Keyed on a stable string (not the fileTree object) so a fresh
  // empty-array fallback during loading can't loop the effect.
  const topDirKeys = fileTree.dirs.map((d) => d.prefix).join("|");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpanded(new Set(topDirKeys ? topDirKeys.split("|") : []));
  }, [agent.slug, topDirKeys]);
  const toggleDir = (prefix: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  const activeContent =
    activeFile === "profile"
      ? profileYaml(agent)
      : (diskFiles.find((f) => f.path === activeFile)?.content ?? "");
  const activeLanguage =
    activeFile === "profile"
      ? "yaml"
      : (diskFiles.find((f) => f.path === activeFile)?.language ?? "text");

  const uploadMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      return uploadAgentFile({
        data: { slug: agent.slug, filename, content },
        headers: csrfHeaders(),
      });
    },
    onSuccess: (_, vars) => {
      toast.success("File uploaded", {
        description: `${vars.filename} written to ${agent.slug} profile directory.`,
      });
      queryClient.invalidateQueries({ queryKey: ["agent-files", agent.slug] });
    },
    onError: (err) => {
      toast.error("Upload failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result;
      if (typeof content !== "string") return;
      uploadMutation.mutate({ filename: file.name, content });
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-uploaded if needed
    e.target.value = "";
  }

  return (
    <div className="grid gap-3 md:grid-cols-[240px_1fr] h-[70vh] min-h-0">
      <div className="flex flex-col min-h-0 border-r pr-2">
        {/* Scrollable file list: profile tab + recursive disk tree */}
        <div className="flex-1 min-h-0 overflow-auto space-y-0.5 pr-1">
          <button
            onClick={() => setActiveFile("profile")}
            className={cn(
              "w-full text-left rounded px-2 py-1.5 text-xs flex items-center gap-2 hover:bg-muted/50 font-mono",
              activeFile === "profile" && "bg-accent text-accent-foreground",
            )}
          >
            <FileText className="size-3 text-muted-foreground shrink-0" />
            <span className="truncate">profile.yaml</span>
          </button>

          {isAdmin && filesQuery.isLoading && (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Loading files…</p>
          )}
          {isAdmin && !filesQuery.isLoading && !hasDiskFiles && (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No files.</p>
          )}
          {hasDiskFiles && (
            <FileTreeNode
              dir={fileTree}
              depth={0}
              activeFile={activeFile}
              onSelect={setActiveFile}
              expanded={expanded}
              toggle={toggleDir}
            />
          )}
        </div>

        <div className="pt-3 mt-2 border-t space-y-1.5 text-xs shrink-0">
          <Tag className="font-mono">{agent.model}</Tag>
          <p className="text-muted-foreground text-[11px]">{agent.slug}</p>
        </div>

        {/* File upload — admin only, scoped to this profile's home directory */}
        {isAdmin && (
          <div className="pt-2 mt-2 border-t shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
              aria-label="Upload file to agent profile directory"
            />
            <Button
              variant="outlined"
              size="small"
              className="w-full h-7 text-xs"
              icon={<Upload />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? "Uploading…" : "Upload file"}
            </Button>
          </div>
        )}
      </div>

      <div className="min-w-0 min-h-0">
        <CodeBlock
          language={activeLanguage}
          code={activeContent}
          className="h-full overflow-auto"
        />
      </div>
    </div>
  );
}

type AgentControlAction = "start" | "stop" | "restart" | "pause";

export default function AgentsPage() {
  const t = useT();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const {
    data: agents = [],
    isLoading,
    isError,
  } = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | AgentRunState>("all");
  const [inspect, setInspect] = useState<Agent | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents.filter((a) => {
      if (stateFilter !== "all" && a.state !== stateFilter) return false;
      if (!needle) return true;
      return [a.name, a.slug, a.model, a.description].some((x) => x.toLowerCase().includes(needle));
    });
  }, [agents, q, stateFilter]);

  const counts = useMemo(
    () => ({
      all: agents.length,
      running: agents.filter((a) => a.state === "running").length,
      idle: agents.filter((a) => a.state === "idle").length,
      stopped: agents.filter((a) => a.state === "stopped").length,
      error: agents.filter((a) => a.state === "error").length,
    }),
    [agents],
  );

  const controlMutation = useMutation({
    mutationFn: async (vars: { action: AgentControlAction; slug: string }) => {
      // Mint a single-use approval token bound to action `agents.action` with
      // the same input the pipeline hashes ({ slug, action }), then dispatch
      // with the token + CSRF headers (mirrors Systemd.tsx dispatch flow).
      const mint = await callMintApproval({
        data: {
          action: APPROVAL_ACTIONS.agentsAction,
          payload: { slug: vars.slug, action: vars.action },
        },
        headers: csrfHeaders(),
      });
      return callAgentAction({
        data: { slug: vars.slug, action: vars.action },
        headers: {
          ...csrfHeaders(),
          "x-cortex-approval-token": mint.token,
        },
      });
    },
    onSuccess: (result) => {
      toast.success(`${result.slug}: ${result.action} ${result.status}`, {
        description: `State is now ${result.state}.`,
      });
      qc.invalidateQueries({ queryKey: ["agents"] }).catch(() => {});
    },
    onError: (err: unknown, vars) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Failed to ${vars.action} ${vars.slug}`, { description: message });
    },
  });

  const handleAction = (action: AgentControlAction, a: Agent) => {
    if (!user?.is_admin) {
      toast.error("Admin only", { description: "You need admin role to control agents." });
      return;
    }
    controlMutation.mutate({ action, slug: a.slug });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Bot className="size-5" />}
        title={t.nav.agents}
        description="Hermes agent fleet — live status, model, and health."
      />

      <FToolbar>
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, model or slug…"
            prefix={<Search className="size-4 text-muted-foreground" aria-hidden />}
            className="h-9"
          />
        </div>
        <div className="flex items-center gap-1 ml-auto flex-wrap">
          {(["all", "running", "idle", "stopped", "error"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStateFilter(s)}
              className={cn(
                "rounded-md border px-2.5 h-8 text-xs capitalize transition-colors",
                stateFilter === s
                  ? "bg-accent text-accent-foreground border-accent"
                  : "hover:bg-muted/50",
              )}
            >
              {s} <span className="text-muted-foreground ml-1 tabular-nums">{counts[s]}</span>
            </button>
          ))}
        </div>
      </FToolbar>

      {(() => {
        if (isLoading) {
          return (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <CardSkeleton key={i} lines={4} />
              ))}
            </div>
          );
        }
        if (isError) {
          return (
            <FCard>
              <EmptyState
                icon={<AlertTriangle className="size-8 text-[var(--destructive)]" />}
                title={t.empty.agents.loadFailedTitle}
                description={t.empty.agents.loadFailedDescription}
              />
            </FCard>
          );
        }
        if (filtered.length === 0) {
          return (
            <FCard>
              <EmptyState
                icon={<Bot className="size-8" />}
                title={t.empty.agents.emptyTitle}
                description={
                  agents.length === 0
                    ? t.empty.agents.emptyNoAgents
                    : t.empty.agents.emptyTryFilters
                }
                action={
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setQ("");
                      setStateFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </FCard>
          );
        }
        return (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((a) => (
              <FCard
                key={a.slug}
                className="p-4 flex flex-col gap-3 group transition-all hover:-translate-y-0.5 hover:elev-2"
              >
                <div className="flex items-start gap-3">
                  <div className="relative shrink-0">
                    <div className="size-10 rounded-md bg-primary/10 text-primary grid place-items-center">
                      <Bot className="size-5" />
                    </div>
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-background",
                        STATE_TONE[a.state],
                        a.state === "running" && "animate-pulse motion-reduce:animate-none",
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{a.name}</h3>
                      <span className="text-[11px] text-muted-foreground font-mono truncate">
                        {a.slug}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                      {a.description}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-[11px] uppercase tracking-wide rounded-full border px-2 py-0.5 shrink-0",
                      HEALTH_TONE[a.health],
                    )}
                  >
                    {HEALTH_LABEL[a.health]}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Model
                    </p>
                    <div className="text-xs mt-0.5 truncate">
                      <span className="font-mono truncate block" title={a.model}>
                        {a.model}
                      </span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Provider
                    </p>
                    <div className="text-xs mt-0.5 truncate">
                      <span className="capitalize">{a.modelProvider}</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Uptime
                    </p>
                    <div className="text-xs mt-0.5 truncate">{formatUptime(a.uptimeSec)}</div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Queue
                    </p>
                    <div className="text-xs mt-0.5 truncate">
                      <span className="tabular-nums">{a.queueDepth}</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Req/min
                    </p>
                    <div className="text-xs mt-0.5 truncate">
                      <span className="tabular-nums">{a.requestsPerMin}</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Error rate
                    </p>
                    <div className="text-xs mt-0.5 truncate">
                      <span className={cn("tabular-nums", errorRateClass(a.errorRatePct))}>
                        {a.errorRatePct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Activity className="size-3" /> p95 {a.p95LatencyMs}ms
                  </span>
                  <span>{relativeTime(a.lastActivity)}</span>
                </div>

                <div className="flex items-center gap-1 pt-1 border-t border-border -mx-4 -mb-4 px-3 py-2 bg-muted/20 rounded-b-xl">
                  <Button
                    size="small"
                    variant="text"
                    className="h-7 text-xs"
                    icon={<FileText />}
                    onClick={() => setInspect(a)}
                  >
                    Inspect
                  </Button>
                  {user?.is_admin && (
                    <Button
                      size="small"
                      variant="text"
                      className="h-7 text-xs"
                      icon={<MessageSquare />}
                      onClick={() =>
                        navigate({ to: "/agents/$slug/chat", params: { slug: a.slug } })
                      }
                    >
                      Chat
                    </Button>
                  )}
                  <div className="flex-1" />
                  {a.state === "running" ? (
                    <>
                      <Button
                        icon={<RotateCw />}
                        variant="outlined"
                        size="small"
                        title="Restart"
                        aria-label="Restart"
                        disabled={controlMutation.isPending}
                        onClick={() => handleAction("restart", a)}
                      />
                      <Button
                        icon={<Pause />}
                        variant="outlined"
                        size="small"
                        title="Pause"
                        aria-label="Pause"
                        disabled={controlMutation.isPending}
                        onClick={() => handleAction("pause", a)}
                      />
                      <Button
                        icon={<Power />}
                        variant="outlined"
                        size="small"
                        danger
                        title="Stop"
                        aria-label="Stop"
                        disabled={controlMutation.isPending}
                        onClick={() => handleAction("stop", a)}
                      />
                    </>
                  ) : a.state === "idle" ? (
                    <>
                      <Button
                        icon={<PlayCircle />}
                        variant="outlined"
                        size="small"
                        title="Resume"
                        aria-label="Resume"
                        disabled={controlMutation.isPending}
                        onClick={() => handleAction("start", a)}
                      />
                      <Button
                        icon={<RotateCw />}
                        variant="outlined"
                        size="small"
                        title="Restart"
                        aria-label="Restart"
                        disabled={controlMutation.isPending}
                        onClick={() => handleAction("restart", a)}
                      />
                      <Button
                        icon={<Power />}
                        variant="outlined"
                        size="small"
                        danger
                        title="Stop"
                        aria-label="Stop"
                        disabled={controlMutation.isPending}
                        onClick={() => handleAction("stop", a)}
                      />
                    </>
                  ) : (
                    <Button
                      icon={<PlayCircle />}
                      variant="outlined"
                      size="small"
                      title="Start"
                      aria-label="Start"
                      disabled={controlMutation.isPending}
                      onClick={() => handleAction("start", a)}
                    />
                  )}
                </div>

                {a.state === "error" && (
                  <div className="flex items-start gap-2 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-2.5 py-1.5 text-[11px] text-[var(--destructive)]">
                    <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                    <span>
                      Agent crashed — check{" "}
                      <Link to="/audit" className="underline">
                        audit log
                      </Link>{" "}
                      for details.
                    </span>
                  </div>
                )}
              </FCard>
            ))}
          </div>
        );
      })()}

      <Modal
        open={!!inspect}
        onCancel={() => setInspect(null)}
        footer={null}
        width={960}
        title={
          <span className="flex items-center gap-2">
            <FolderTree className="size-4" />
            {inspect?.name}{" "}
            <span className="text-xs text-muted-foreground font-mono">{inspect?.slug}</span>
          </span>
        }
      >
        {inspect && <InspectorBody agent={inspect} isAdmin={!!user?.is_admin} />}
      </Modal>
    </div>
  );
}
