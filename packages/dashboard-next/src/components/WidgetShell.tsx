import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Standard wrapper for every Overview widget.
 *
 * Rules (single source of truth):
 *  - Always fills the grid cell: `h-full w-full flex flex-col`
 *  - Same padding everywhere: p-4 (header pb-3, body uses remaining space)
 *  - Body never overflows the card: `min-h-0 overflow-hidden`
 *  - Scrollable bodies opt-in via `scroll` prop (`overflow-auto`)
 *  - One border, one shadow, one radius — provided by `.elev-1` + card token
 */
interface Props {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Allow the body to scroll instead of clip. Default: clip. */
  scroll?: boolean;
  /** Remove inner padding (for charts that need bleed). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}

export function WidgetShell({
  title,
  icon,
  actions,
  children,
  scroll = false,
  flush = false,
  className,
  bodyClassName,
}: Props) {
  return (
    <div
      className={cn(
        "elev-1 h-full w-full flex flex-col rounded-xl border bg-card text-card-foreground overflow-hidden",
        className,
      )}
    >
      {title && (
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
            <h3 className="text-sm font-semibold leading-none truncate">{title}</h3>
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      <div
        className={cn(
          "flex-1 min-h-0",
          flush ? "p-0" : "px-4 pb-4",
          !title && !flush && "pt-4",
          scroll ? "overflow-auto" : "overflow-hidden",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
