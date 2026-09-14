import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, X, LayoutGrid, Server, ScrollText, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Tooltip } from "@lobehub/ui/base-ui";
import brandMark from "@/assets/cortexos-mark.svg";
import { NAV, PINNED, type GroupId } from "./NavConfig";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

interface Props {
  collapsed: boolean;
  mobileOpen: boolean;
  onClose: () => void;
}

const GROUP_ICONS: Record<GroupId, LucideIcon> = {
  platform: LayoutGrid,
  infra: Server,
  secOps: ScrollText,
  admin: Settings2,
};

const STORAGE_KEY = "cortex.nav.openGroups";

function NavLink({
  to,
  icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const link = (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-muted hover:text-sidebar-foreground",
        collapsed && "md:justify-center md:px-2",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-[var(--primary)]"
        />
      )}
      <span className="shrink-0">{icon}</span>
      <span className={cn("truncate", collapsed && "md:hidden")}>{label}</span>
    </Link>
  );

  if (collapsed) {
    return (
      <li>
        <Tooltip title={label} placement="right" openDelay={200}>
          {link}
        </Tooltip>
      </li>
    );
  }

  return <li>{link}</li>;
}

export function Sidebar({ collapsed, mobileOpen, onClose }: Props) {
  const t = useT();
  const { user } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });

  // Exactly one nav item is active: the one whose `to` is the LONGEST prefix of
  // the current path. So /incus/$name lights only "Incus" (not a shorter prefix),
  // and /agents/$slug/chat lights "Agents".
  const activeTo =
    [PINNED.to, ...NAV.flatMap((g) => g.items.map((it) => it.to))]
      .filter((to) => path === to || path.startsWith(`${to}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null;

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    platform: true,
    infra: true,
    secOps: true,
    admin: false,
  });

  // Hydrate from localStorage after mount to avoid SSR mismatch
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (stored && typeof stored === "object") setOpenGroups((prev) => ({ ...prev, ...stored }));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    // Auto-expand the group containing the active route
    setOpenGroups((prev) => {
      const next = { ...prev };
      NAV.forEach((g) => {
        if (g.items.some((it) => path.startsWith(it.to))) next[g.id] = true;
      });
      return next;
    });
  }, [path]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(openGroups));
    } catch {
      /* noop */
    }
  }, [openGroups]);

  const toggle = (id: string) => setOpenGroups((p) => ({ ...p, [id]: !p[id] }));

  // Admin-only groups are hidden for non-admin users (role from real PAM groups).
  const visibleNav = NAV.filter((g) => !g.adminOnly || user?.is_admin);

  const groupTitle: Record<GroupId, string> = {
    platform: t.nav.platform,
    infra: t.nav.infra,
    secOps: t.nav.secOps,
    admin: t.nav.admin,
  };

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} aria-hidden />
      )}
      <aside
        className={cn(
          "z-50 mac-vibrant text-sidebar-foreground border-r border-sidebar-border/70 shrink-0 flex flex-col",
          "fixed inset-y-0 left-0 transform transition-transform md:relative md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "md:w-16" : "md:w-[232px]",
          "w-64",
        )}
      >
        <div className="h-14 flex items-center justify-between border-b border-sidebar-border px-3">
          <Link to="/overview" className="flex items-center gap-2 min-w-0">
            <img src={brandMark} alt="" className="size-7 shrink-0" aria-hidden />
            {!collapsed && (
              <span className="font-semibold tracking-tight truncate">{t.app.name}</span>
            )}
          </Link>
          <button
            onClick={onClose}
            className="md:hidden text-sidebar-foreground/60"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
          {/* Pinned: Overview */}
          <ul className="space-y-0.5 mb-2">
            <NavLink
              to={PINNED.to}
              icon={<PINNED.icon className="size-4" />}
              label={t.nav[PINNED.key]}
              active={path === PINNED.to}
              collapsed={collapsed}
              onClick={onClose}
            />
          </ul>

          {visibleNav.map((group) => {
            const Icon = GROUP_ICONS[group.id];
            const isOpen = openGroups[group.id] ?? true;
            const hasActive = group.items.some((it) => path.startsWith(it.to));

            // Collapsed sidebar: just show items flat with separators
            if (collapsed) {
              return (
                <div key={group.id} className="hidden md:block">
                  <div className="my-2 h-px bg-sidebar-border/50" />
                  <ul className="space-y-0.5">
                    {group.items.map((it) => (
                      <NavLink
                        key={it.to}
                        to={it.to}
                        icon={<it.icon className="size-4" />}
                        label={t.nav[it.key]}
                        active={it.to === activeTo}
                        collapsed
                        onClick={onClose}
                      />
                    ))}
                  </ul>
                </div>
              );
            }

            return (
              <div key={group.id}>
                <button
                  onClick={() => toggle(group.id)}
                  className={cn(
                    "w-full flex items-center gap-2 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                    hasActive
                      ? "text-sidebar-foreground"
                      : "text-muted-foreground hover:text-sidebar-foreground hover:bg-muted",
                  )}
                  aria-expanded={isOpen}
                >
                  <Icon className="size-3.5" />
                  <span className="flex-1 text-left">{groupTitle[group.id]}</span>
                  <ChevronDown
                    className={cn("size-3 transition-transform", !isOpen && "-rotate-90")}
                  />
                </button>
                {isOpen && (
                  <ul className="mt-0.5 ml-2 pl-2 border-l border-sidebar-border/60 space-y-0.5">
                    {group.items.map((it) => (
                      <NavLink
                        key={it.to}
                        to={it.to}
                        icon={<it.icon className="size-4" />}
                        label={t.nav[it.key]}
                        active={it.to === activeTo}
                        collapsed={false}
                        onClick={onClose}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>

        <div className={cn("border-t border-sidebar-border p-3 space-y-2", collapsed && "md:px-2")}>
          <div className={cn("flex items-center gap-2 text-xs", collapsed && "md:justify-center")}>
            <span className="size-2 rounded-full bg-[var(--success)]" />
            {!collapsed && <span className="text-sidebar-foreground/70">{t.live.connected}</span>}
          </div>
          {!collapsed && user && (
            <div className="flex items-center gap-2 rounded-md bg-sidebar-accent/40 px-2 py-1.5">
              <div className="size-7 grid place-items-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">{user.username}</p>
                <p className="text-[11px] text-sidebar-foreground/60">
                  {user.is_admin ? "Admin" : "User"}
                </p>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
