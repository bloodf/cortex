import { statusColor, type Status } from "@/lib/status";
import { ms } from "@/lib/format";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";

export function StatusBadge({
  status,
  responseTime,
  compact = false,
}: {
  status: Status;
  responseTime?: number;
  compact?: boolean;
}) {
  const t = useT();
  const c = statusColor(status);
  const label = t.status[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        c.bg,
        c.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", c.dot)} aria-hidden />
      {!compact && <span>{label}</span>}
      {!compact && status === "online" && typeof responseTime === "number" && (
        <span className="tabular-nums opacity-70">· {ms(responseTime)}</span>
      )}
    </span>
  );
}
