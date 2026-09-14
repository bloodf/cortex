import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function KeyValueList({
  items,
  className,
}: {
  items: { key: string; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm", className)}>
      {items.map((it) => (
        <div key={it.key} className="contents">
          <dt className="text-muted-foreground">{it.key}</dt>
          <dd className="font-mono text-xs sm:text-sm break-all">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
