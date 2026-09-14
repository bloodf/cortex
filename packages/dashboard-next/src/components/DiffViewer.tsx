import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface Props {
  before: string;
  after: string;
  className?: string;
  /** Header label rendered above each pane. */
  labels?: { before: string; after: string };
}

interface Row {
  type: "same" | "add" | "del";
  text: string;
  lineA?: number;
  lineB?: number;
}

/**
 * Minimal line-based diff viewer. No external deps; uses LCS for change
 * detection. Renders side-by-side with +/- gutter coloring.
 */
/** Tiny LCS diff. O(n*m) — fine for config files. */
function diff(a: string[], b: string[]): Row[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  let la = 1;
  let lb = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i], lineA: la, lineB: lb });
      la += 1;
      lb += 1;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i], lineA: la });
      la += 1;
      i += 1;
    } else {
      rows.push({ type: "add", text: b[j], lineB: lb });
      lb += 1;
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: a[i], lineA: la });
    i += 1;
    la += 1;
  }
  while (j < m) {
    rows.push({ type: "add", text: b[j], lineB: lb });
    j += 1;
    lb += 1;
  }
  return rows;
}

export function DiffViewer({
  before,
  after,
  className,
  labels = { before: "Before", after: "After" },
}: Props) {
  const rows = useMemo(() => diff(before.split("\n"), after.split("\n")), [before, after]);

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden text-xs font-mono", className)}>
      <div className="grid grid-cols-2 border-b text-[11px] uppercase tracking-wide text-muted-foreground bg-surface-2">
        <div className="px-3 py-1.5 border-r">{labels.before}</div>
        <div className="px-3 py-1.5">{labels.after}</div>
      </div>
      <div className="grid grid-cols-2 overflow-x-auto">
        <pre className="m-0">
          {rows.map((r, i) => (
            <div
              key={`a${i}`}
              className={cn(
                "px-3 py-0.5 whitespace-pre",
                r.type === "del" && "bg-destructive/10 text-destructive",
                r.type === "add" && "opacity-30",
              )}
            >
              <span className="inline-block w-6 select-none text-muted-foreground">
                {r.lineA ?? ""}
              </span>
              {r.type === "add" ? "" : `${r.type === "del" ? "- " : "  "}${r.text}`}
            </div>
          ))}
        </pre>
        <pre className="m-0 border-l">
          {rows.map((r, i) => (
            <div
              key={`b${i}`}
              className={cn(
                "px-3 py-0.5 whitespace-pre",
                r.type === "add" && "bg-[var(--success)]/10 text-[var(--success)]",
                r.type === "del" && "opacity-30",
              )}
            >
              <span className="inline-block w-6 select-none text-muted-foreground">
                {r.lineB ?? ""}
              </span>
              {r.type === "del" ? "" : `${r.type === "add" ? "+ " : "  "}${r.text}`}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
