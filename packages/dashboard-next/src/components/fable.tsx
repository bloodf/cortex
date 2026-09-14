import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { severityColor } from "@/lib/status";

/** Standard content card. Replaces ad-hoc `rounded-lg border bg-card` combos. */
export function FCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-border bg-card elev-1", className)}>
      {children}
    </div>
  );
}

/** Card section header: title + optional actions, consistent padding. */
export function FCardHeader({
  title,
  actions,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border px-4 py-3",
        className,
      )}
    >
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {actions}
    </div>
  );
}

/** KPI stat: big number + label + optional delta/spark slot. */
export function FStat({
  label,
  value,
  hint,
  spark,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  spark?: ReactNode;
  className?: string;
}) {
  return (
    <FCard className={cn("p-4", className)}>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      {spark && <div className="mt-2">{spark}</div>}
    </FCard>
  );
}

/** Status dot with semantic color. */
export function FDot({
  status,
  className,
}: {
  status: "ok" | "warn" | "err" | "off";
  className?: string;
}) {
  const color = severityColor(status).dot;
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        color,
        status === "ok" && "shadow-[0_0_6px_var(--success)]",
        className,
      )}
    />
  );
}

/** Page toolbar row: wraps filters/actions with consistent gap + wrap. */
export function FToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/** Canonical form label. */
export function FLabel({
  children,
  htmlFor,
  className,
}: {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn("text-xs font-medium text-muted-foreground", className)}>
      {children}
    </label>
  );
}

/** Terminal/log/code surface — replaces inline raw-color oklch panels. */
export function FTerminal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-terminal-bg text-terminal-fg p-3 font-mono text-xs overflow-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}
