import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center text-center py-16 px-4", className)}
    >
      {icon && (
        <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
