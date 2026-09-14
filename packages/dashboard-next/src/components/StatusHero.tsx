import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { FCard, FDot } from "@/components/fable";
import { cn } from "@/lib/utils";

/**
 * Top-of-page system health banner. Aggregates services + CPU + memory into
 * one calm sentence ("All systems operational", "1 service degraded", ...).
 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono font-medium tabular-nums">{value}</div>
    </div>
  );
}

export function StatusHero({ className }: { className?: string }) {
  const { data: services = [] } = useQuery({ queryKey: ["services"], queryFn: api.services });
  const { data: system } = useQuery({ queryKey: ["system"], queryFn: api.system });

  const down = services.filter((s) => s.status === "offline").length;
  const total = services.length;
  const cpu = system?.cpu ?? 0;
  const mem = system?.memory.percent ?? 0;

  let level: "ok" | "warn" | "down" = "ok";
  let label = "All systems operational";
  let detail = `${total} services online · CPU ${Math.round(cpu)}% · Mem ${Math.round(mem)}%`;

  if (down > 0) {
    level = "down";
    label = `${down} service${down > 1 ? "s" : ""} offline`;
    detail = `${total - down} of ${total} healthy · CPU ${Math.round(cpu)}% · Mem ${Math.round(mem)}%`;
  } else if (cpu > 85 || mem > 88) {
    level = "warn";
    label = "Elevated load";
    detail = `CPU ${Math.round(cpu)}% · Mem ${Math.round(mem)}% · ${total} services online`;
  }

  const dot = level === "down" ? "err" : level;

  return (
    <FCard className={cn("bg-gradient-to-r from-accent/40 to-transparent", className)}>
      <div className="flex items-center gap-3 px-4 py-3">
        <FDot status={dot} className="size-2.5" />
        <div className="min-w-0">
          <p className="font-medium leading-none">{label}</p>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="ml-auto hidden sm:flex items-center gap-4 text-xs">
          <Stat label="Services" value={`${total - down}/${total}`} />
          <Stat label="CPU" value={`${Math.round(cpu)}%`} />
          <Stat label="Memory" value={`${Math.round(mem)}%`} />
        </div>
      </div>
    </FCard>
  );
}
