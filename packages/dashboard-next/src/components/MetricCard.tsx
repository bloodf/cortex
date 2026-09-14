import type { ReactNode } from "react";
import { FCard } from "@/components/fable";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  trend?: ReactNode;
  /** "vertical" stacks trend under text. "horizontal" puts trend on the right. */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

export function MetricCard({
  label,
  value,
  hint,
  icon,
  trend,
  orientation = "vertical",
  className,
}: Props) {
  const horizontal = orientation === "horizontal";
  return (
    <FCard className={cn("h-full w-full flex flex-col overflow-hidden", className)}>
      <div
        className={cn(
          "p-4 flex-1 min-h-0",
          horizontal ? "flex items-stretch gap-3" : "flex flex-col gap-3",
        )}
      >
        <div
          className={cn(
            "flex items-start justify-between gap-2",
            horizontal && "flex-col flex-1 min-w-0",
          )}
        >
          <div className="space-y-1 min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">
              {label}
            </p>
            <p className="text-2xl font-semibold tabular-nums leading-tight truncate">{value}</p>
            {hint && <p className="text-xs text-muted-foreground truncate">{hint}</p>}
          </div>
          {icon && !horizontal && <div className="text-muted-foreground shrink-0">{icon}</div>}
        </div>
        {trend && (
          <div
            className={cn(
              "min-h-0 overflow-hidden",
              horizontal ? "flex-1 min-w-0 self-stretch" : "mt-auto flex-1",
            )}
          >
            {trend}
          </div>
        )}
      </div>
    </FCard>
  );
}
