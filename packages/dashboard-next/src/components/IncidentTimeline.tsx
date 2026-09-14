import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import type { AlertHistory } from "@/mocks/types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function IncidentTimeline({ items }: { items: AlertHistory[] }) {
  const sorted = [...items].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No incidents recorded.</p>;
  }
  return (
    <ol className="relative border-l ml-3 space-y-5 py-1">
      {sorted.map((it) => {
        const fired = it.status === "fired";
        const resolved = it.status === "resolved";
        return (
          <li key={it.id} className="ml-5 relative">
            <span
              className={cn(
                "absolute -left-[34px] top-0.5 flex size-6 items-center justify-center rounded-full ring-4 ring-background",
                fired && "bg-destructive/15 text-destructive",
                resolved && "bg-[var(--success)]/15 text-[var(--success)]",
                !fired && !resolved && "bg-muted text-muted-foreground",
              )}
            >
              {(() => {
                if (fired) return <AlertTriangle className="size-3.5" />;
                if (resolved) return <CheckCircle2 className="size-3.5" />;
                return <Circle className="size-3.5" />;
              })()}
            </span>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h4 className="font-medium text-sm">{it.ruleName}</h4>
              <time className="text-xs text-muted-foreground tabular-nums">
                {relativeTime(it.timestamp)}
              </time>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="font-mono">{it.serviceName}</span> · {it.message}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
