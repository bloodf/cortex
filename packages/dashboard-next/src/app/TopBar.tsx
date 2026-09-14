import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Check,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  Monitor,
  Palette,
  LogOut,
  ChevronRight,
  User as UserIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, DropdownMenu } from "@lobehub/ui/base-ui";
import { Popover } from "@lobehub/ui";
import { EmptyState } from "@/components/EmptyState";
import { useUI } from "@/hooks/useUI";
import { ACCENTS } from "@/hooks/accents";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/hooks/useT";
import { api, callMarkNotificationsRead } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { NAV } from "./NavConfig";
import { relativeTime } from "@/lib/format";
import { severityColor } from "@/lib/status";
import { cn } from "@/lib/utils";

function ThemeIcon({ theme }: { theme: string }) {
  if (theme === "dark") return <Moon className="size-4" />;
  if (theme === "light") return <Sun className="size-4" />;
  return <Monitor className="size-4" />;
}

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenMobile: () => void;
  onOpenPalette: () => void;
  onOpenHelp?: () => void;
}

function breadcrumbs(path: string, t: ReturnType<typeof useT>): { label: string; to?: string }[] {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return [{ label: t.nav.overview }];
  // try to find matching nav label
  const all = NAV.flatMap((g) => g.items);
  const out: { label: string; to?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = `/${parts.slice(0, i + 1).join("/")}`;
    const nav = all.find((n) => n.to === p);
    if (nav) out.push({ label: t.nav[nav.key], to: i < parts.length - 1 ? p : undefined });
    else out.push({ label: parts[i].replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) });
  }
  return out;
}

export function TopBar({
  collapsed,
  onToggleCollapse,
  onOpenMobile,
  onOpenPalette,
  onOpenHelp,
}: Props) {
  const { theme, setTheme, accent, setAccent } = useUI();
  const { user, logout } = useAuth();
  const t = useT();
  const path = useRouterState({ select: (s) => s.location.pathname });

  const crumbs = breadcrumbs(path, t);

  const qc = useQueryClient();
  const { data: notifs = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: api.notifications,
  });
  const unread = notifs.filter((n) => !n.read).length;

  const markAllRead = async (): Promise<void> => {
    try {
      const res = await callMarkNotificationsRead({ data: {}, headers: csrfHeaders() });
      if (res.acknowledged > 0) {
        toast.success(
          `Marked ${res.acknowledged} notification${res.acknowledged === 1 ? "" : "s"} read`,
        );
      }
      qc.invalidateQueries({ queryKey: ["notifications"] }).catch(() => {});
    } catch {
      toast.error("Failed to mark notifications read");
    }
  };

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-border bg-card/80 backdrop-blur flex items-center gap-2 px-3 sm:px-5">
      <Button
        type="text"
        shape="circle"
        icon={<Menu className="size-4" />}
        className="md:hidden"
        onClick={onOpenMobile}
        aria-label="Menu"
      />
      <Button
        type="text"
        shape="circle"
        icon={
          collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />
        }
        className="hidden md:inline-flex"
        onClick={onToggleCollapse}
        aria-label="Toggle sidebar"
      />

      <nav className="hidden md:flex items-center text-sm text-muted-foreground min-w-0">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center min-w-0">
            {i > 0 && <ChevronRight className="size-3 mx-1 opacity-50" />}
            {c.to ? (
              <Link to={c.to} className="hover:text-foreground truncate">
                {c.label}
              </Link>
            ) : (
              <span className="text-foreground font-medium truncate" aria-current="page">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="flex-1" />

      <button
        onClick={onOpenPalette}
        className="hidden sm:flex items-center gap-2 rounded-lg border border-border/70 bg-muted/50 px-3 h-8 text-sm text-muted-foreground hover:bg-muted/80 transition-colors min-w-[200px] lg:min-w-[280px]"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">{t.common.search}</span>
        <kbd className="hidden lg:inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[11px] font-mono">
          ⌘K
        </kbd>
      </button>

      <Button
        type="text"
        shape="circle"
        icon={<Search className="size-4" />}
        className="sm:hidden"
        onClick={onOpenPalette}
        aria-label="Search"
      />
      {onOpenHelp && (
        <Button
          type="text"
          shape="circle"
          icon={<kbd className="text-[11px] font-mono">?</kbd>}
          onClick={onOpenHelp}
          aria-label="Keyboard shortcuts"
          className="hidden md:inline-flex"
        />
      )}

      <DropdownMenu
        placement="bottomRight"
        items={[
          {
            type: "group",
            label: "Theme",
            children: [
              {
                type: "checkbox",
                key: "light",
                checked: theme === "light",
                onCheckedChange: () => setTheme("light"),
                icon: <Sun className="size-3.5" />,
                label: "Light",
              },
              {
                type: "checkbox",
                key: "dark",
                checked: theme === "dark",
                onCheckedChange: () => setTheme("dark"),
                icon: <Moon className="size-3.5" />,
                label: "Dark",
              },
              {
                type: "checkbox",
                key: "system",
                checked: theme === "system",
                onCheckedChange: () => setTheme("system"),
                icon: <Monitor className="size-3.5" />,
                label: "System",
              },
            ],
          },
        ]}
      >
        <Button type="text" shape="circle" icon={<ThemeIcon theme={theme} />} aria-label="Theme" />
      </DropdownMenu>

      <DropdownMenu
        placement="bottomRight"
        items={[
          {
            type: "group",
            label: "Accent",
            children: ACCENTS.map((a) => ({
              key: a.id,
              onClick: () => setAccent(a.id),
              icon: <span className="size-3 rounded-full" style={{ background: a.color }} />,
              label: a.label,
              extra: accent === a.id ? <Check className="size-3.5" /> : undefined,
            })),
          },
        ]}
      >
        <Button
          type="text"
          shape="circle"
          icon={<Palette className="size-4" />}
          aria-label="Accent"
        />
      </DropdownMenu>

      <Popover
        placement="bottomRight"
        className="w-80 p-0"
        content={
          <div>
            <div className="px-3 py-2 border-b flex items-center justify-between">
              <span className="text-sm font-medium">Notifications</span>
              {unread > 0 ? (
                <button
                  type="button"
                  onClick={() => markAllRead().catch(() => {})}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  <Check className="size-3" />
                  Mark all read
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">{unread} unread</span>
              )}
            </div>
            {notifs.length === 0 ? (
              <EmptyState
                icon={<Bell className="size-5" />}
                title="No notifications"
                description="You're all caught up."
              />
            ) : (
              <ul className="max-h-80 overflow-y-auto divide-y">
                {notifs.map((n) => {
                  let severity: "err" | "warn" | "off" = "off";
                  if (n.severity === "error") {
                    severity = "err";
                  } else if (n.severity === "warn") {
                    severity = "warn";
                  }
                  return (
                  <li key={n.id} className="px-3 py-2.5 hover:bg-muted/40">
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          "size-1.5 rounded-full mt-1.5 shrink-0",
                          severityColor(severity).dot,
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{n.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{n.body}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {relativeTime(n.timestamp)}
                        </p>
                      </div>
                    </div>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        }
      >
        <Button
          type="text"
          shape="circle"
          icon={
            <span className="relative inline-flex">
              <Bell className="size-4" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-[var(--destructive)]" />
              )}
            </span>
          }
          aria-label="Notifications"
          className="min-h-10 min-w-10"
        />
      </Popover>

      <DropdownMenu
        placement="bottomRight"
        popupProps={{ className: "min-w-56" }}
        header={
          <span className="flex items-center gap-2 px-1 py-0.5">
            <UserIcon className="size-4" />
            <span>
              <span className="block text-sm font-medium">{user?.username}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {user?.is_admin ? "Administrator" : "User"}
              </span>
            </span>
          </span>
        }
        items={[
          {
            key: "logout",
            danger: true,
            icon: <LogOut className="size-3.5" />,
            label: t.auth.logout,
            onClick: () => {
              logout()
                .finally(() => {
                  window.location.href = "/login";
                })
                .catch(() => {});
            },
          },
        ]}
      >
        <button
          className="flex items-center gap-2 rounded-md hover:bg-muted px-1.5 py-1 transition-colors"
          aria-label="Account"
        >
          <div className="size-7 grid place-items-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
            {user?.username.slice(0, 2).toUpperCase() ?? "?"}
          </div>
        </button>
      </DropdownMenu>
    </header>
  );
}
