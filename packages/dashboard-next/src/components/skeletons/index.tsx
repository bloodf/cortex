import { cn } from "@/lib/utils";

/** Base skeleton block. Uses tailwind's animate-pulse and design-system muted token. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted/70 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/** Header + rows skeleton sized like a DataTable. */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3" data-testid="table-skeleton" aria-hidden>
      <div className="flex items-center gap-2 pb-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-24 ml-auto" />
      </div>
      <div className="border rounded-md overflow-hidden">
        <div
          className="grid border-b bg-muted/30 px-4 py-2.5 gap-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
        >
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-3.5 w-20" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="grid border-b last:border-b-0 px-4 py-3 gap-3 items-center"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
          >
            {Array.from({ length: cols }).map((_c, c) => {
              let widthClass: string;
              if (c === 0) widthClass = "w-3/4";
              else if (c === cols - 1) widthClass = "w-1/3";
              else widthClass = "w-2/3";
              return <Skeleton key={c} className={cn("h-4", widthClass)} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Card skeleton: title + paragraph lines. */
export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div
      className={cn("border rounded-lg p-5 space-y-3", className)}
      data-testid="card-skeleton"
      aria-hidden
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-1/2" />
      <div className="space-y-2 pt-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
        ))}
      </div>
    </div>
  );
}

/** Chart-shaped skeleton with a fake area silhouette. */
export function ChartSkeleton({
  height = 200,
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("border rounded-lg p-4 space-y-3", className)}
      data-testid="chart-skeleton"
      aria-hidden
    >
      <div className="flex justify-between">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="relative w-full overflow-hidden rounded" style={{ height }}>
        <Skeleton className="absolute inset-0" />
        <svg
          className="absolute inset-0 size-full opacity-40"
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
        >
          <path
            d="M0,32 L10,28 L20,30 L30,22 L40,24 L50,18 L60,20 L70,12 L80,16 L90,10 L100,14 L100,40 L0,40 Z"
            fill="currentColor"
            className="text-foreground/20"
          />
        </svg>
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

/** Detail-page skeleton: title block + 2-column meta + table. */
export function DetailSkeleton() {
  return (
    <div className="space-y-6" data-testid="detail-skeleton" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
      </div>
      <TableSkeleton rows={5} cols={4} />
    </div>
  );
}

/** Sparkline / inline mini skeleton. */
export function InlineSkeleton({
  width = 64,
  className,
}: {
  width?: number | string;
  className?: string;
}) {
  return <Skeleton className={cn("h-4 inline-block align-middle", className)} style={{ width }} />;
}
