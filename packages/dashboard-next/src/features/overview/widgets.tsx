import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  Thermometer,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Database,
  BarChart3,
  Wifi,
  Fan,
} from "lucide-react";
import { Tag } from "@lobehub/ui";
import { SparkAreaChart } from "@lobehub/charts";
import { Progress } from "@/components/ui/progress";
import { FDot, FStat } from "@/components/fable";
import { WidgetShell } from "@/components/WidgetShell";

import { AreaTrend } from "@/components/AreaTrend";
import { api } from "@/lib/api/client";
import { bytes, kbps, duration, percent, relativeTime } from "@/lib/format";
import { tempColor, usageBg } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useRingHistory } from "@/hooks/useRingHistory";

// ── Individual widget components ──────────────────────────────
export function CpuW() {
  const { data: sys } = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    refetchInterval: 3000,
  });
  const history = useRingHistory(sys?.cpu, 30);
  return (
    <FStat
      className="h-full"
      label="CPU"
      value={percent(sys?.cpu ?? 0)}
      hint={sys?.load?.length ? `load ${sys.load.map((l) => l.toFixed(2)).join(" ")}` : undefined}
      spark={
        <SparkAreaChart
          data={history.map((v, i) => ({ t: i, v }))}
          index="t"
          categories={["v"]}
          colors={["var(--chart-1)"]}
          height={40}
        />
      }
    />
  );
}
export function MemW() {
  const { data: sys } = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    refetchInterval: 3000,
  });
  const history = useRingHistory(sys?.memory.percent, 30);
  return (
    <FStat
      className="h-full"
      label="Memory"
      value={percent(sys?.memory.percent ?? 0)}
      hint={`${bytes(sys?.memory.used ?? 0)} / ${bytes(sys?.memory.total ?? 0)}`}
      spark={
        <SparkAreaChart
          data={history.map((v, i) => ({ t: i, v }))}
          index="t"
          categories={["v"]}
          colors={["var(--chart-2)"]}
          height={40}
        />
      }
    />
  );
}
export function StorageW() {
  const { data: sys } = useQuery({ queryKey: ["system"], queryFn: api.system });
  const totalDrives = sys?.drives.reduce((a, d) => a + (d.total ?? d.size), 0) ?? 0;
  const usedDrives = sys?.drives.reduce((a, d) => a + (d.used ?? 0), 0) ?? 0;
  const pct = totalDrives ? (usedDrives / totalDrives) * 100 : 0;
  return (
    <FStat
      className="h-full"
      label="Storage"
      value={percent(pct)}
      hint={`${bytes(usedDrives)} / ${bytes(totalDrives)}`}
      spark={<Progress value={pct} className="h-1.5" />}
    />
  );
}
export function CpuTempW() {
  const { data: sys } = useQuery({ queryKey: ["system"], queryFn: api.system });
  const t = sys?.sensors.cpuTemperature?.value ?? 0;
  return (
    <FStat
      className="h-full"
      label="CPU Temp"
      value={<span className={tempColor(t)}>{t.toFixed(1)}°C</span>}
      hint={sys?.sensors.cpuTemperature?.label}
    />
  );
}
export function ServicesW() {
  const { data: services = [] } = useQuery({
    queryKey: ["services"],
    queryFn: api.services,
    refetchInterval: 3000,
  });
  const on = services.filter((s) => s.status === "online").length;
  const off = services.filter((s) => s.status === "offline").length;
  const unk = services.filter((s) => s.status === "unknown").length;
  const bad = off + unk;
  return (
    <FStat
      className="h-full"
      label="Services"
      value={`${on}/${services.length}`}
      hint={bad > 0 ? `${bad} offline` : "all online"}
    />
  );
}
export function LiveTrendW() {
  const { data: sys } = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    refetchInterval: 3000,
  });
  const cpuHistory = useRingHistory(sys?.cpu, 40);
  const memHistory = useRingHistory(sys?.memory.percent, 40);
  const data = cpuHistory.map((cpu, i) => ({ t: i, cpu, mem: memHistory[i] ?? 0 }));
  return (
    <WidgetShell title="Live performance" icon={<Activity className="size-4" />}>
      <div className="h-full w-full">
        <AreaTrend
          data={data}
          series={[
            { key: "cpu", color: "var(--chart-1)", name: "CPU %" },
            { key: "mem", color: "var(--chart-2)", name: "Memory %" },
          ]}
          yDomain={[0, 100]}
          height="100%"
        />
      </div>
    </WidgetShell>
  );
}
export function SensorsW() {
  const { data: sys } = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    refetchInterval: 3000,
  });
  const temps = sys?.sensors.temperatures ?? [];
  const fans = sys?.sensors.fans ?? [];
  return (
    <WidgetShell title="Sensors" icon={<Thermometer className="size-4" />} scroll>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {temps.map((t) => (
          <div key={t.id} className="flex justify-between gap-2 min-w-0">
            <span className="text-muted-foreground truncate">{t.label}</span>
            <span className={cn("font-mono tabular-nums shrink-0", tempColor(t.value))}>
              {t.value.toFixed(1)}°
            </span>
          </div>
        ))}
        {fans.map((f) => (
          <div key={f.id} className="flex justify-between gap-2 min-w-0">
            <span className="text-muted-foreground truncate flex items-center gap-1">
              <Fan className="size-3 shrink-0" />
              {f.label}
            </span>
            <span className="font-mono tabular-nums shrink-0">{Math.round(f.value)}</span>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}
export function ProcessesW() {
  const { data: procs = [] } = useQuery({ queryKey: ["processes"], queryFn: api.processes });
  const top = useMemo(() => [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, 6), [procs]);
  return (
    <WidgetShell title="Top processes" icon={<Cpu className="size-4" />} scroll>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="text-left py-1 font-medium">PID</th>
            <th className="text-left font-medium">User</th>
            <th className="text-left font-medium">Command</th>
            <th className="text-right font-medium">CPU</th>
            <th className="text-right font-medium">MEM</th>
          </tr>
        </thead>
        <tbody>
          {top.map((p) => (
            <tr key={p.pid} className="border-t">
              <td className="py-1.5 font-mono tabular-nums">{p.pid}</td>
              <td className="truncate max-w-[120px]">{p.user}</td>
              <td className="font-mono text-xs truncate max-w-[220px]">{p.command}</td>
              <td className="text-right tabular-nums">{p.cpu.toFixed(1)}%</td>
              <td className="text-right tabular-nums">{p.mem.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetShell>
  );
}
export function NetworkW() {
  const { data: net } = useQuery({
    queryKey: ["network"],
    queryFn: api.network,
    refetchInterval: 3000,
  });
  const rxNow = net?.interfaces.reduce((a, i) => a + i.rxKbps, 0) ?? 0;
  const txNow = net?.interfaces.reduce((a, i) => a + i.txKbps, 0) ?? 0;
  const rxHistory = useRingHistory(rxNow, 40);
  const txHistory = useRingHistory(txNow, 40);
  const data = rxHistory.map((rx, i) => ({ t: i, rx, tx: txHistory[i] ?? 0 }));
  return (
    <WidgetShell title="Network" icon={<Wifi className="size-4" />}>
      <div className="h-full grid grid-cols-[minmax(0,9rem)_1fr] gap-3">
        {/* Left column: Rx/Tx stacked + interface list */}
        <div className="flex flex-col gap-2 min-w-0">
          <div className="rounded-lg bg-[var(--surface-2)] p-2 min-w-0">
            <p className="text-[11px] uppercase text-muted-foreground flex items-center gap-1">
              <ArrowDown className="size-3" /> Rx
            </p>
            <p className="text-base font-semibold tabular-nums truncate">{kbps(rxNow)}</p>
          </div>
          <div className="rounded-lg bg-[var(--surface-2)] p-2 min-w-0">
            <p className="text-[11px] uppercase text-muted-foreground flex items-center gap-1">
              <ArrowUp className="size-3" /> Tx
            </p>
            <p className="text-base font-semibold tabular-nums truncate">{kbps(txNow)}</p>
          </div>
          <div className="flex-1 min-h-0 overflow-auto space-y-1 pt-1">
            {net?.interfaces.map((i) => (
              <div key={i.name} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono text-muted-foreground flex items-center gap-1 truncate">
                  <Wifi className="size-3 shrink-0" />
                  {i.name}
                </span>
                <span className="tabular-nums shrink-0">{kbps(i.rxKbps + i.txKbps)}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Right column: chart fills remaining space */}
        <div className="min-w-0 min-h-0">
          <AreaTrend
            data={data}
            series={[
              { key: "rx", color: "var(--chart-1)", name: "Rx" },
              { key: "tx", color: "var(--chart-2)", name: "Tx" },
            ]}
            height="100%"
          />
        </div>
      </div>
    </WidgetShell>
  );
}
export function AlertsW() {
  const { data: alerts = [] } = useQuery({
    queryKey: ["alerts", "history"],
    queryFn: api.alerts.history,
  });
  return (
    <WidgetShell title="Recent alerts" icon={<AlertTriangle className="size-4" />} scroll>
      <div className="space-y-2 text-sm">
        {alerts.slice(0, 6).map((a) => {
          let color: "red" | "green" | "default" = "default";
          if (a.status === "fired") color = "red";
          else if (a.status === "resolved") color = "green";
          return (
            <div
              key={a.id}
              className="flex items-start gap-2 border-b last:border-0 pb-2 last:pb-0"
            >
              <Tag color={color} className="text-[11px] uppercase">
                {a.status}
              </Tag>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{a.ruleName}</p>
                <p className="text-[11px] text-muted-foreground">{relativeTime(a.timestamp)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </WidgetShell>
  );
}
export function UptimeW() {
  const { data: sys } = useQuery({ queryKey: ["system"], queryFn: api.system });
  return <FStat className="h-full" label="Uptime" value={duration(sys?.uptime ?? 0)} />;
}
export function DockerW() {
  const { data: containers = [] } = useQuery({
    queryKey: ["docker", "containers"],
    queryFn: api.docker.containers,
  });
  const running = containers.filter((c) => c.state === "running").length;
  return (
    <FStat
      className="h-full"
      label="Docker"
      value={`${running}/${containers.length}`}
      hint="containers running"
    />
  );
}
export function IncusW() {
  const { data: instances = [] } = useQuery({ queryKey: ["incus"], queryFn: api.incus });
  const active = instances.filter((i) => i.status === "active").length;
  return (
    <FStat
      className="h-full"
      label="Incus"
      value={`${active}/${instances.length}`}
      hint="instances active"
    />
  );
}
export function DbW() {
  const { data: services = [] } = useQuery({ queryKey: ["services"], queryFn: api.services });
  const dbs = services.filter((s) => s.category === "Database");
  return (
    <WidgetShell title="Databases" icon={<Database className="size-4" />} scroll>
      <div className="space-y-2 text-sm">
        {dbs.map((s) => (
          <div key={s.slug} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0">
              <FDot status={s.status === "online" ? "ok" : "err"} />
              <span className="truncate">{s.name}</span>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {s.responseTime > 0 ? `${s.responseTime.toFixed(0)} ms` : "—"}
            </span>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}
export function MonW() {
  const { data: services = [] } = useQuery({ queryKey: ["services"], queryFn: api.services });
  const mon = services.filter((s) => s.category === "Monitoring");
  return (
    <WidgetShell title="Monitoring" icon={<BarChart3 className="size-4" />} scroll>
      <div className="space-y-2 text-sm">
        {mon.map((s) => (
          <div key={s.slug} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0">
              <FDot status={s.status === "online" ? "ok" : "err"} />
              <span className="truncate">{s.name}</span>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {s.responseTime > 0 ? `${s.responseTime.toFixed(0)} ms` : "—"}
            </span>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}
export function DrivesW() {
  const { data: sys } = useQuery({ queryKey: ["system"], queryFn: api.system });
  return (
    <WidgetShell title="Drives" icon={<HardDrive className="size-4" />} scroll>
      <div className="space-y-2">
        {sys?.drives.map((d) => {
          const pct = d.percent ?? (d.total && d.used ? (d.used / d.total) * 100 : 0);
          let pctClass = "text-muted-foreground";
          if (pct >= 90) pctClass = "text-destructive";
          else if (pct >= 75) pctClass = "text-[var(--warning)]";
          return (
            <div key={d.name} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono truncate min-w-0">{d.name}</span>
                <span className={cn("tabular-nums shrink-0", pctClass)}>
                  {bytes(d.used ?? 0)} / {bytes(d.total ?? d.size)} · {pct.toFixed(0)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={cn("h-full", usageBg(pct))} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </WidgetShell>
  );
}

// ── Widget catalog moved to `./widget-catalog.tsx` ────────────
// The catalog (`WIDGETS`, `WIDGET_MAP`, `DEFAULT_LAYOUT`, `WidgetSpec`) is
// pure data; it was previously in this file but the
// `react-refresh/only-export-components` rule fires on the array literals
// (the rule's `allowConstantExport: true` only whitelists primitive
// `Literal`/`UnaryExpression`/`TemplateLiteral`/`BinaryExpression` initializers
// — not `ArrayExpression`). Consumers import from `./widget-catalog` now;
// this file keeps only the widget component implementations.
