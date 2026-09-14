import type { ReactNode } from "react";

export function PageHeader({
  icon,
  title,
  description,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
            {icon}
          </div>
        )}
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
