import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Waypoints, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Segmented, Select, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { TechIcon } from "@/components/TechIcon";
import { AutostartToggle } from "@/components/AutostartToggle";
import { TableSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { FDot, FToolbar } from "@/components/fable";
import {
  api,
  callScanDependenciesNow,
  callSetDependencyEdge,
  callRemoveDependencyEdge,
} from "@/lib/api/client";
import type { DependencyEdgeKind, DependencyEdgeSource, ServiceNodeInfo } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// xyflow element types. Edge provenance lives in `edge.data.source`, never in
// the `edge.source` field (which carries the source NODE id for xyflow).
// ---------------------------------------------------------------------------

interface ServiceNodeData extends Record<string, unknown> {
  service: ServiceNodeInfo;
  dimmed: boolean;
  focused: boolean;
  isAdmin: boolean;
}

interface DepEdgeData extends Record<string, unknown> {
  kind: DependencyEdgeKind;
  source: DependencyEdgeSource;
  detail: string | null;
}

type CategoryGroupData = Record<string, unknown> & { label: string };

type FlowNode = Node<ServiceNodeData, "service">;
type GroupNode = Node<CategoryGroupData, "categoryGroup">;
type AnyNode = FlowNode | GroupNode;
type FlowEdge = Edge<DepEdgeData>;

const NODE_W = 220;
const NODE_H = 120;
const CELL_W = NODE_W + 24;
const CELL_H = NODE_H + 20;
const GROUP_PAD_TOP = 40;
const GROUP_PAD_X = 16;
const GROUP_COLS = 2;

const POS_KEY = "cortex.depgraph.pos.v1";
const MODE_KEY = "cortex.depgraph.mode.v1";

type GroupMode = "groups" | "flow";

// --- Edge / category coloring -------------------------------------------------
const PROVIDER_COLORS: Record<string, string> = {
  durindoor: "var(--chart-6)",
  postgresql: "var(--chart-1)",
  redis: "var(--chart-5)",
  mysql: "var(--chart-4)",
  mongodb: "var(--chart-3)",
  prometheus: "var(--chart-4)",
  loki: "var(--chart-7)",
  hindsight: "var(--chart-8)",
};
const EDGE_FALLBACK = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
];
function hashIndex(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % EDGE_FALLBACK.length;
}
function edgeColor(targetSlug: string): string {
  if (PROVIDER_COLORS[targetSlug]) return PROVIDER_COLORS[targetSlug];
  return `var(${EDGE_FALLBACK[hashIndex(targetSlug)]})`;
}
function categoryColor(category: string): string {
  return `var(${EDGE_FALLBACK[hashIndex(category)]})`;
}

function formatMem(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// --- localStorage position persistence ---------------------------------------
function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { x: number; y: number }>) : {};
  } catch {
    return {};
  }
}
function savePositions(pos: Record<string, { x: number; y: number }>): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* noop */
  }
}
function loadMode(): GroupMode {
  try {
    return localStorage.getItem(MODE_KEY) === "flow" ? "flow" : "groups";
  } catch {
    return "groups";
  }
}

// --- Layout -------------------------------------------------------------------
interface LayoutResult {
  groups: GroupNode[];
  positions: Map<string, { x: number; y: number }>; // service slug -> position (absolute in flow mode, relative-to-parent in groups mode)
  parentOf: Map<string, string>; // service slug -> category group id
}

/** Flow mode: dagre over the service graph directly, LR. Orphans stacked after. */
function layoutFlow(services: ServiceNodeInfo[], edges: DepEdge[]): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: 80, nodesep: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const slugs = new Set(services.map((s) => s.slug));
  for (const s of services) g.setNode(s.slug, { width: NODE_W, height: NODE_H });
  const connected = new Set<string>();
  for (const e of edges) {
    if (slugs.has(e.sourceSlug) && slugs.has(e.targetSlug)) {
      g.setEdge(e.sourceSlug, e.targetSlug);
      connected.add(e.sourceSlug);
      connected.add(e.targetSlug);
    }
  }
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  let maxX = 0;
  for (const s of services) {
    if (!connected.has(s.slug)) continue;
    const n = g.node(s.slug);
    if (!n) continue;
    positions.set(s.slug, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
    maxX = Math.max(maxX, n.x - NODE_W / 2);
  }
  // Orphans: final column, stacked.
  const orphanX = maxX + CELL_W;
  let orphanRow = 0;
  for (const s of services) {
    if (connected.has(s.slug)) continue;
    positions.set(s.slug, { x: orphanX, y: orphanRow * CELL_H });
    orphanRow += 1;
  }
  return { groups: [], positions, parentOf: new Map() };
}

/** Groups mode: a category parent node per category, laid out on a meta-graph,
 *  services grid-placed inside their category (positions relative to parent). */
function layoutGroups(services: ServiceNodeInfo[], edges: DepEdge[]): LayoutResult {
  const byCategory = new Map<string, ServiceNodeInfo[]>();
  for (const s of services) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  const cats = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));

  const positions = new Map<string, { x: number; y: number }>();
  const parentOf = new Map<string, string>();
  const catToSize = new Map<string, { w: number; h: number }>();
  const catSlugs = new Map<string, Set<string>>();

  for (const [cat, list] of cats) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    const rows = Math.ceil(list.length / GROUP_COLS);
    const w = GROUP_COLS * CELL_W + GROUP_PAD_X * 2;
    const h = GROUP_PAD_TOP + rows * CELL_H + GROUP_PAD_X;
    catToSize.set(cat, { w, h });
    const groupId = `cat:${cat}`;
    const members = new Set<string>();
    list.forEach((s, i) => {
      const col = i % GROUP_COLS;
      const row = Math.floor(i / GROUP_COLS);
      positions.set(s.slug, {
        x: GROUP_PAD_X + col * CELL_W,
        y: GROUP_PAD_TOP + row * CELL_H,
      });
      parentOf.set(s.slug, groupId);
      members.add(s.slug);
    });
    catSlugs.set(cat, members);
  }

  // Meta-graph: categories as nodes, distinct cross-category edges between them.
  const mg = new dagre.graphlib.Graph();
  mg.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 60 });
  mg.setDefaultEdgeLabel(() => ({}));
  const slugToCat = new Map<string, string>();
  for (const [cat, members] of catSlugs) for (const slug of members) slugToCat.set(slug, cat);
  for (const [cat, size] of catToSize) mg.setNode(cat, { width: size.w, height: size.h });
  const metaSeen = new Set<string>();
  for (const e of edges) {
    const a = slugToCat.get(e.sourceSlug);
    const b = slugToCat.get(e.targetSlug);
    if (!a || !b || a === b) continue;
    const key = `${a}->${b}`;
    if (metaSeen.has(key)) continue;
    metaSeen.add(key);
    mg.setEdge(a, b);
  }
  dagre.layout(mg);

  const groups: GroupNode[] = [];
  for (const [cat, size] of catToSize) {
    const mn = mg.node(cat);
    const gx = mn ? mn.x - size.w / 2 : 0;
    const gy = mn ? mn.y - size.h / 2 : 0;
    groups.push({
      id: `cat:${cat}`,
      type: "categoryGroup",
      position: { x: gx, y: gy },
      draggable: false,
      selectable: false,
      style: {
        width: size.w,
        height: size.h,
        backgroundColor: "var(--surface-2)",
        border: "1px dashed var(--border)",
        borderRadius: 16,
      },
      data: { label: cat },
    });
  }
  return { groups, positions, parentOf };
}

// --- Custom nodes -------------------------------------------------------------
function CategoryGroup({ data }: NodeProps<GroupNode>) {
  return (
    <div
      className="pointer-events-none select-none px-2 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
      style={{ padding: 8 }}
    >
      {data.label}
    </div>
  );
}

function ServiceCard({ data }: NodeProps<FlowNode>) {
  const { service: s, dimmed, focused, isAdmin } = data;
  const hasBackend = s.unitName !== null || (s.containerNames?.length ?? 0) > 0;
  return (
    <div
      className={cn(
        "w-[220px] rounded-xl border bg-card p-3 elev-1 transition-opacity",
        dimmed && "opacity-35",
        focused && "ring-2 ring-[var(--ring)]",
      )}
      style={{ borderLeft: `3px solid ${categoryColor(s.category)}` }}
    >
      {isAdmin && (
        <Handle type="target" position={Position.Left} className="!bg-[var(--primary)]" />
      )}
      <div className="flex items-start gap-2">
        <TechIcon slug={s.slug} name={s.name} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <FDot status={s.running ? "ok" : "off"} />
            <span className="truncate text-sm font-medium">{s.name}</span>
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{s.slug}</p>
        </div>
        {hasBackend && <AutostartToggle slug={s.slug} enabled={s.autostart} disabled={!isAdmin} />}
      </div>
      {(s.memBytes !== null || s.cpuPct !== null) && (
        <div className="mt-2 flex gap-3 text-[11px] tabular-nums text-muted-foreground">
          {s.memBytes !== null && <span>{formatMem(s.memBytes)}</span>}
          {s.cpuPct !== null && <span>{s.cpuPct.toFixed(1)}% CPU</span>}
        </div>
      )}
      <div className="mt-1.5">
        <Tag variant="outlined" className="text-[11px]">
          {s.category}
        </Tag>
      </div>
      {isAdmin && (
        <Handle type="source" position={Position.Right} className="!bg-[var(--primary)]" />
      )}
    </div>
  );
}

const nodeTypes = { service: ServiceCard, categoryGroup: CategoryGroup };

// Shape of a dependency edge from the API payload.
interface DepEdge {
  id: number;
  sourceSlug: string;
  targetSlug: string;
  kind: DependencyEdgeKind;
  source: DependencyEdgeSource;
  detail: string | null;
}

export default function DependenciesPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;

  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<"all" | DependencyEdgeKind>("all");
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("groups");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focusSlug, setFocusSlug] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    positionsRef.current = loadPositions();
    setGroupMode(loadMode());
  }, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["dependencies"],
    queryFn: api.dependencies.list,
    refetchInterval: 15_000,
  });

  const services = useMemo(() => data?.nodes ?? [], [data]);
  const depEdges = useMemo<DepEdge[]>(() => data?.edges ?? [], [data]);

  const categories = useMemo(
    () => [...new Set(services.map((s) => s.category))].sort(),
    [services],
  );

  // Orphans: zero inbound AND outbound edges (candidates to disable — with the
  // legend's disclaimer: absence of an edge never proves a service unused).
  const orphanSlugs = useMemo(() => {
    const connected = new Set<string>();
    for (const e of depEdges) {
      connected.add(e.sourceSlug);
      connected.add(e.targetSlug);
    }
    return new Set(services.filter((s) => !connected.has(s.slug)).map((s) => s.slug));
  }, [services, depEdges]);

  const visibleServices = useMemo(() => {
    if (categoryFilter === "all") return services;
    return services.filter((s) => s.category === categoryFilter);
  }, [services, categoryFilter]);

  // Neighbors of the focused node (for selection highlighting).
  const neighborsOf = useCallback(
    (slug: string): Set<string> => {
      const set = new Set<string>([slug]);
      for (const e of depEdges) {
        if (e.sourceSlug === slug) set.add(e.targetSlug);
        if (e.targetSlug === slug) set.add(e.sourceSlug);
      }
      return set;
    },
    [depEdges],
  );

  // ---- Controlled-node sync: never overwrite user-dragged positions. --------
  useEffect(() => {
    const visibleSet = new Set(visibleServices.map((s) => s.slug));
    const layout =
      groupMode === "groups"
        ? layoutGroups(visibleServices, depEdges)
        : layoutFlow(visibleServices, depEdges);
    const neighbors = focusSlug ? neighborsOf(focusSlug) : null;

    setNodes((prev) => {
      const prevServiceById = new Map(
        prev.filter((n): n is FlowNode => n.type === "service").map((n) => [n.id, n]),
      );
      const next: AnyNode[] = [...layout.groups];
      for (const s of visibleServices) {
        const dimmed = orphansOnly
          ? !orphanSlugs.has(s.slug)
          : neighbors
            ? !neighbors.has(s.slug)
            : false;
        const focused = focusSlug === s.slug;
        const existing = prevServiceById.get(s.slug);
        const stored = positionsRef.current[s.slug];
        const parentId = layout.parentOf.get(s.slug);
        const base: FlowNode = {
          id: s.slug,
          type: "service",
          position: existing?.position ?? stored ?? layout.positions.get(s.slug) ?? { x: 0, y: 0 },
          data: { service: s, dimmed, focused, isAdmin },
          ...(parentId ? { parentId, extent: "parent" as const } : {}),
        };
        next.push(base);
      }
      return next;
    });

    const nextEdges: FlowEdge[] = [];
    for (const e of depEdges) {
      if (kindFilter !== "all" && e.kind !== kindFilter) continue;
      if (!visibleSet.has(e.sourceSlug) || !visibleSet.has(e.targetSlug)) continue;
      const touchesFocus = !focusSlug || e.sourceSlug === focusSlug || e.targetSlug === focusSlug;
      const dashArray = e.source === "manual" ? "2 3" : e.kind === "observed" ? "6 4" : undefined;
      nextEdges.push({
        id: `e-${e.id}`,
        source: e.sourceSlug,
        target: e.targetSlug,
        animated: e.source !== "manual" && e.kind === "observed",
        style: {
          stroke: "var(--border)",
          strokeWidth: touchesFocus ? (focusSlug ? 2.5 : 1.5) : 1.5,
          strokeDasharray: dashArray,
          opacity: focusSlug && !touchesFocus ? 0.12 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--border)" },
        data: { kind: e.kind, source: e.source, detail: e.detail },
      });
    }
    setEdges(nextEdges);
  }, [
    visibleServices,
    depEdges,
    kindFilter,
    isAdmin,
    orphansOnly,
    orphanSlugs,
    groupMode,
    focusSlug,
    neighborsOf,
    setNodes,
    setEdges,
  ]);

  const onNodesChangeWrapped = useCallback(
    (changes: NodeChange<AnyNode>[]) => onNodesChange(changes),
    [onNodesChange],
  );

  const onNodeDragStop = useCallback((_: unknown, node: AnyNode) => {
    if (node.type !== "service") return;
    positionsRef.current[node.id] = node.position;
    savePositions(positionsRef.current);
  }, []);

  const handleReset = useCallback(() => {
    positionsRef.current = {};
    try {
      localStorage.removeItem(POS_KEY);
    } catch {
      /* noop */
    }
    // Re-run layout by clearing nodes; the sync effect rebuilds them.
    setNodes([]);
  }, [setNodes]);

  const changeMode = useCallback((m: GroupMode) => {
    setGroupMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* noop */
    }
  }, []);

  const handleRescan = async () => {
    setScanning(true);
    try {
      const result = await callScanDependenciesNow({ data: {}, headers: csrfHeaders() });
      toast.success(`Scan complete: ${result.edges.length} edge(s)`);
      await refetch();
    } catch {
      toast.error("Dependency scan failed");
    } finally {
      setScanning(false);
    }
  };

  const onConnect = useCallback(
    async (conn: Connection) => {
      if (!isAdmin) return;
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      try {
        await callSetDependencyEdge({
          data: { sourceSlug: conn.source, targetSlug: conn.target, kind: "configured" },
          headers: csrfHeaders(),
        });
        toast.success(`Manual edge: ${conn.source} → ${conn.target}`);
        qc.invalidateQueries({ queryKey: ["dependencies"] }).catch(() => {});
      } catch {
        toast.error("Failed to add manual edge");
      }
    },
    [qc, isAdmin],
  );

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelectedEdgeId(params.edges.length === 1 ? (params.edges[0]?.id ?? null) : null);
  }, []);

  const onNodeClick = useCallback((_: unknown, node: AnyNode) => {
    if (node.type !== "service") return;
    setFocusSlug((cur) => (cur === node.id ? null : node.id));
  }, []);

  const onPaneClick = useCallback(() => setFocusSlug(null), []);

  // Manual-edge delete only: ReactFlow's built-in delete is disabled
  // (deleteKeyCode={null}) so seed/detected edges can never be transiently
  // removed from the canvas.
  const onKeyDown = useCallback(
    async (e: KeyboardEvent<HTMLDivElement>) => {
      if (!isAdmin) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selectedEdgeId) return;
      const edge = edges.find((x) => x.id === selectedEdgeId);
      if (!edge || edge.data?.source !== "manual") return;
      e.preventDefault();
      try {
        await callRemoveDependencyEdge({
          data: { sourceSlug: edge.source, targetSlug: edge.target, kind: edge.data.kind },
          headers: csrfHeaders(),
        });
        toast.success("Manual edge removed");
        setSelectedEdgeId(null);
        qc.invalidateQueries({ queryKey: ["dependencies"] }).catch(() => {});
      } catch {
        toast.error("Failed to remove edge");
      }
    },
    [selectedEdgeId, edges, qc, isAdmin],
  );

  // Legend: per-provider color chips for distinct targetSlugs (max 10 by count).
  const legendChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of depEdges) counts.set(e.targetSlug, (counts.get(e.targetSlug) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([slug]) => slug);
  }, [depEdges]);

  const serviceNodeCount = nodes.filter((n) => n.type === "service").length;

  let body;
  if (isLoading) {
    body = <TableSkeleton rows={6} cols={4} />;
  } else if (isError) {
    body = <EmptyState title="Failed to load dependencies" />;
  } else if (serviceNodeCount === 0) {
    body = <EmptyState title="No services match the category filter" />;
  } else {
    body = (
      <div
        className="h-[calc(100vh-260px)] min-h-[480px] w-full rounded-xl border bg-[var(--background)]"
        data-focus-slug={focusSlug ?? undefined}
        onKeyDown={(e) => {
          onKeyDown(e);
        }}
        tabIndex={0}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChangeWrapped}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onConnect={isAdmin ? (c) => {
            onConnect(c);
          } : undefined}
          onSelectionChange={onSelectionChange}
          deleteKeyCode={null}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--border)" />
          <MiniMap pannable zoomable className="!bg-card" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Waypoints className="size-5" />}
        title="Dependencies"
        description="Service dependency graph — configured, observed, and manual edges"
        actions={
          <FToolbar>
            <Segmented
              size="small"
              value={groupMode}
              onChange={(v) => changeMode(v as GroupMode)}
              options={[
                { label: "Groups", value: "groups" },
                { label: "Flow", value: "flow" },
              ]}
            />
            <Select
              size="small"
              value={categoryFilter}
              onChange={(v) => setCategoryFilter(v)}
              aria-label="Filter by category"
              options={[
                { label: "All categories", value: "all" },
                ...categories.map((c) => ({ label: c, value: c })),
              ]}
            />
            <Select
              size="small"
              value={kindFilter}
              onChange={(v) => setKindFilter(v as "all" | DependencyEdgeKind)}
              aria-label="Filter by edge kind"
              options={[
                { label: "All edge kinds", value: "all" },
                { label: "Configured", value: "configured" },
                { label: "Observed", value: "observed" },
              ]}
            />
            <Button
              type={orphansOnly ? "primary" : "default"}
              variant={orphansOnly ? undefined : "outlined"}
              size="small"
              onClick={() => setOrphansOnly((v) => !v)}
            >
              Unreferenced ({orphanSlugs.size})
            </Button>
            <Button variant="outlined" size="small" onClick={handleReset}>
              Reset layout
            </Button>
            {isAdmin && (
              <Button
                type="primary"
                size="small"
                disabled={scanning}
                onClick={() => {
                  handleRescan();
                }}
              >
                {scanning ? (
                  <Loader2 className="mr-1.5 size-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 size-4" />
                )}
                Rescan
              </Button>
            )}
          </FToolbar>
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-2 text-xs text-muted-foreground">
        {legendChips.map((slug) => (
          <span key={slug} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3" style={{ backgroundColor: edgeColor(slug) }} />
            {slug}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 bg-muted-foreground" /> configured
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-5 bg-muted-foreground"
            style={{ borderTop: "1px dashed" }}
          />{" "}
          observed (animated)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-5 bg-muted-foreground"
            style={{ borderTop: "1px dotted" }}
          />{" "}
          manual
        </span>
        <span className="ml-auto max-w-md italic">
          No edge ≠ unused — configured edges come from static config; observed edges from live
          connections at last scan.
        </span>
      </div>

      {body}
    </div>
  );
}
