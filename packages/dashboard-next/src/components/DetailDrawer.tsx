import type { ReactNode } from "react";
import { Drawer, Tabs } from "@lobehub/ui";

export interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  tabs: DetailTab[];
  actions?: ReactNode;
}

export function DetailDrawer({ open, onOpenChange, title, description, tabs, actions }: Props) {
  return (
    <Drawer
      open={open}
      onClose={() => onOpenChange(false)}
      placement="right"
      width={640}
      title={
        <span className="flex items-center justify-between gap-3">
          <span className="truncate">{title}</span>
          {actions && <span className="flex gap-1 shrink-0">{actions}</span>}
        </span>
      }
    >
      {description && (
        <div className="mb-3 text-sm text-muted-foreground border-b border-border pb-3">
          {description}
        </div>
      )}
      <Tabs
        items={tabs.map((t) => ({
          key: t.id,
          label: t.label,
          children: <div className="space-y-4 pt-2">{t.content}</div>,
        }))}
      />
    </Drawer>
  );
}
