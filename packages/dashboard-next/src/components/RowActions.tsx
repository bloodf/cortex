import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@lobehub/ui";
import { DropdownMenu } from "@lobehub/ui/base-ui";
import { cn } from "@/lib/utils";

export type RowActionVariant =
  "outline" | "outline-success" | "outline-warning" | "outline-destructive" | "ghost";

export interface RowAction {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  variant?: RowActionVariant;
  disabled?: boolean;
  /** Render a separator above this action in the dropdown menu. */
  separatorBefore?: boolean;
}

const VARIANT_COLOR: Record<RowActionVariant, string> = {
  outline: "",
  "outline-success": "text-[var(--success)]",
  "outline-warning": "text-[var(--warning)]",
  "outline-destructive": "text-[var(--destructive)]",
  ghost: "",
};

/** Approx width of one icon button (size-7 = 28px) + gap-1 (4px). */
const BUTTON_SLOT = 32;

export function RowActions({
  actions,
  className,
  align = "end",
}: {
  actions: RowAction[];
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return () => {};
    }
    const required = actions.length * BUTTON_SLOT;
    const check = () => {
      const available = el.clientWidth;
      // collapse if not enough room for all inline buttons (leave a 4px tolerance)
      setCollapsed(available > 0 && available + 4 < required && actions.length > 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [actions.length]);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "flex items-center gap-1",
        align === "end" && "justify-end",
        align === "center" && "justify-center",
        className,
      )}
    >
      {collapsed ? (
        <DropdownMenu
          placement="bottomRight"
          items={actions.flatMap((a) => [
            ...(a.separatorBefore ? [{ key: `__sep-${a.key}`, type: "divider" as const }] : []),
            {
              key: a.key,
              label: (
                <span
                  className={cn(
                    "inline-flex items-center gap-2",
                    VARIANT_COLOR[a.variant ?? "ghost"],
                  )}
                >
                  <span className="inline-flex size-4 items-center justify-center [&_svg]:size-3.5">
                    {a.icon}
                  </span>
                  <span>{a.label}</span>
                </span>
              ),
              disabled: a.disabled,
              onClick: () => a.onSelect(),
            },
          ])}
        >
          <Button
            type="text"
            shape="circle"
            size="small"
            aria-label="Row actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenu>
      ) : (
        actions.map((a) => {
          const variant = a.variant ?? "ghost";
          return (
            <Button
              key={a.key}
              type={variant === "ghost" ? "text" : "default"}
              variant={variant === "ghost" ? undefined : "outlined"}
              shape="circle"
              size="small"
              className={VARIANT_COLOR[variant]}
              title={a.label}
              aria-label={a.label}
              disabled={a.disabled}
              onClick={(e) => {
                e.stopPropagation();
                a.onSelect();
              }}
            >
              {a.icon}
            </Button>
          );
        })
      )}
    </div>
  );
}
