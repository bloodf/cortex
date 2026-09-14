import { useMemo, useState } from "react";
import { AreaTrend } from "./AreaTrend";
import { cn } from "@/lib/utils";

export type TimeRange = "1h" | "24h" | "7d";
const RANGE_LABEL: Record<TimeRange, string> = { "1h": "1h", "24h": "24h", "7d": "7d" };
const RANGE_POINTS: Record<TimeRange, number> = { "1h": 60, "24h": 96, "7d": 84 };

interface Series {
  key: string;
  color: string;
  name: string;
}

interface Props {
  /** Live data array (most-recent last). Used as-is for 1h, synthesized for 24h/7d. */
  data: Record<string, number | string>[];
  series: Series[];
  height?: number;
  defaultRange?: TimeRange;
  className?: string;
}

/**
 * Wraps AreaTrend with a 1h/24h/7d toggle. Longer ranges are synthesized
 * deterministically from the live buffer so the demo always has data.
 */
export function TimeRangeAreaTrend({
  data,
  series,
  height = 180,
  defaultRange = "1h",
  className,
}: Props) {
  const [range, setRange] = useState<TimeRange>(defaultRange);

  const display = useMemo(() => {
    if (range === "1h") return data;
    const points = RANGE_POINTS[range];
    const last = data[data.length - 1] ?? {};
    return Array.from({ length: points }, (_, i) => {
      const row: Record<string, number | string> = { t: i };
      series.forEach((s) => {
        const base = Number(last[s.key] ?? 50);
        // Deterministic-ish wave so it doesn't shuffle on every render
        const wave = Math.sin((i / points) * Math.PI * (range === "24h" ? 4 : 7));
        const jitter = ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
        row[s.key] = Math.max(2, Math.min(98, base + wave * 18 + jitter * 8));
      });
      return row;
    });
  }, [data, range, series]);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex justify-end">
        <div className="inline-flex rounded-md border bg-card p-0.5 text-xs">
          {(["1h", "24h", "7d"] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={cn(
                "px-2.5 py-1 rounded-sm transition-colors",
                range === r
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>
      <AreaTrend data={display} series={series} height={height} />
    </div>
  );
}
