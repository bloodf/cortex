import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { Tooltip } from "@lobehub/ui";
import { useAuth } from "@/hooks/useAuth";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** When true and user lacks admin: wraps the disabled child in a tooltip. Default true. */
  showTooltip?: boolean;
  message?: string;
}

/**
 * Gates a button/action behind admin role.
 * - Admin user → renders children unchanged.
 * - Standard user → renders the child disabled with a "Requires admin" tooltip.
 */
export default function AdminOnly({
  children,
  fallback,
  showTooltip = true,
  message = "Requires admin role",
}: Props) {
  const { user } = useAuth();
  if (user?.is_admin) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (!isValidElement(children)) return null;

  const disabledChild = children as ReactElement<{
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
    disabled?: boolean;
    "aria-disabled"?: boolean;
  }>;
  const disabled = cloneElement(disabledChild, {
    disabled: true,
    "aria-disabled": true,
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    className: `${disabledChild.props.className ?? ""} opacity-50 cursor-not-allowed`,
  });

  if (!showTooltip) return disabled;
  return (
    <Tooltip
      title={
        <span className="text-xs">
          <Lock className="size-3 inline mr-1" />
          {message}
        </span>
      }
    >
      <span className="inline-flex">{disabled}</span>
    </Tooltip>
  );
}
