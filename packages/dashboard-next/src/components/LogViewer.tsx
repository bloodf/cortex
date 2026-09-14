import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface Props {
  lines: string[];
  className?: string;
  height?: number;
  follow?: boolean;
}

export function LogViewer({ lines, className, height = 320, follow = true }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-border bg-terminal-bg text-terminal-fg overflow-auto font-mono text-xs",
        className,
      )}
      style={{ height }}
    >
      <div className="px-3 py-2 space-y-0.5">
        {lines.map((l, i) => {
          const isErr = /ERROR|FATAL|failed|panic/i.test(l);
          const isWarn = /WARN|warning/i.test(l);
          const isInfo = /INFO|started|listening/i.test(l);
          return (
            <div key={i} className="flex gap-2">
              <span className="text-white/30 select-none w-10 text-right shrink-0">{i + 1}</span>
              <span
                className={cn(
                  isErr && "text-[var(--destructive)]",
                  isWarn && "text-[var(--warning)]",
                  isInfo && "text-[var(--success)]",
                )}
              >
                {l}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
