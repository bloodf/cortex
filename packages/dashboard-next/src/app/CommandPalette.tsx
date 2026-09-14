import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Moon, Sun, Palette, Keyboard, LogOut, Search, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Command as CommandPrimitive } from "cmdk";
import { Modal } from "@lobehub/ui/base-ui";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/hooks/useT";
import { useUI } from "@/hooks/useUI";
import { ACCENTS } from "@/hooks/accents";
import {
  api,
  callMintApproval,
  callSystemdAction,
  dockerPruneEstimate,
  callMarkNotificationsRead,
} from "@/lib/api/client";
import { APPROVAL_ACTIONS } from "@/lib/api/approval-actions";
import { csrfHeaders } from "@/lib/csrf";
import { bytes } from "@/lib/format";
import { severityColor } from "@/lib/status";
import { cn } from "@/lib/utils";
import { NAV, PINNED } from "./NavConfig";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onOpenHelp?: () => void;
}

const RECENT_KEY = "cortex.palette.recent";

export function CommandPalette({ open, onOpenChange, onOpenHelp }: Props) {
  const t = useT();
  const { user, logout } = useAuth();
  const { theme, setTheme, accent, setAccent } = useUI();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: services = [] } = useQuery({ queryKey: ["services"], queryFn: api.services });
  const { data: containers = [] } = useQuery({
    queryKey: ["docker", "containers"],
    queryFn: api.docker.containers,
  });
  const { data: units = [] } = useQuery({ queryKey: ["systemd"], queryFn: api.systemd });
  const { data: audit = [] } = useQuery({ queryKey: ["audit"], queryFn: api.audit });
  const [recent, setRecent] = useState<string[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"));
    } catch {
      /* noop */
    }
  }, [open]);

  const navItems = useMemo(() => [PINNED, ...NAV.flatMap((g) => g.items)], []);

  const close = () => onOpenChange(false);

  const runNav = (to: string) => {
    const next = [to, ...recent.filter((r) => r !== to)].slice(0, 5);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
    close();
    navigate({ to });
  };

  // --- Real privileged actions (plan 0.5) ---------------------------------

  /** Restart caddy.service via the REAL systemd RPC (approval-gated, SR-120). */
  const restartCaddy = async (): Promise<void> => {
    const name = "caddy.service";
    const action = "restart" as const;
    try {
      // Pipeline hashes actionHashFor(APPROVAL_ACTIONS.systemdAction, { action, name }).
      const mint = await callMintApproval({
        data: { action: APPROVAL_ACTIONS.systemdAction, payload: { action, name } },
        headers: csrfHeaders(),
      });
      await callSystemdAction({
        data: { action, name },
        headers: { ...csrfHeaders(), "x-cortex-approval-token": mint.token },
      });
      toast.success(`${name}: restart dispatched`);
    } catch {
      toast.error(`Failed to restart ${name}`);
    }
  };

  /** Show a TRUE reclaimable estimate from `docker system df` (dry-run only). */
  const pruneDockerEstimate = async (): Promise<void> => {
    try {
      const est = await dockerPruneEstimate({ data: {} });
      if (est.unavailable) {
        toast.error("Docker prune estimate unavailable");
        return;
      }
      toast.info(`Dry-run: would reclaim ${bytes(est.reclaimableBytes)}`, {
        description: `Images ${bytes(est.breakdown.images)} · Build cache ${bytes(
          est.breakdown.buildCache,
        )}`,
      });
    } catch {
      toast.error("Failed to estimate docker reclaimable space");
    }
  };

  /** Mark all notifications read via the REAL RPC, then refresh the bell. */
  const markAllRead = async (): Promise<void> => {
    try {
      const res = await callMarkNotificationsRead({ data: {}, headers: csrfHeaders() });
      toast.success(
        res.acknowledged > 0
          ? `Marked ${res.acknowledged} notification${res.acknowledged === 1 ? "" : "s"} read`
          : "No unread notifications",
      );
      qc.invalidateQueries({ queryKey: ["notifications"] }).catch(() => {});
    } catch {
      toast.error("Failed to mark notifications read");
    }
  };

  const actions: {
    id: string;
    label: string;
    icon: LucideIcon;
    admin?: boolean;
    run: () => void;
  }[] = [
    {
      id: "act-theme",
      label: `Switch theme to ${theme === "dark" ? "light" : "dark"}`,
      icon: theme === "dark" ? Sun : Moon,
      run: () => {
        setTheme(theme === "dark" ? "light" : "dark");
        toast.success("Theme switched");
      },
    },
    { id: "act-help", label: "Show keyboard shortcuts", icon: Keyboard, run: () => onOpenHelp?.() },
    {
      id: "act-restart-caddy",
      label: "Restart caddy.service",
      icon: Lock,
      admin: true,
      run: () => {
        restartCaddy().catch(() => {});
      },
    },
    {
      id: "act-prune-docker",
      label: "Docker prune (dry-run)",
      icon: Lock,
      admin: true,
      run: () => {
        pruneDockerEstimate().catch(() => {});
      },
    },
    {
      id: "act-new-incus",
      label: "New Incus instance",
      icon: Lock,
      admin: true,
      run: () => runNav("/incus"),
    },
    {
      id: "act-mark-read",
      label: "Mark all notifications read",
      icon: Lock,
      run: () => {
        markAllRead().catch(() => {});
      },
    },
    {
      id: "act-logout",
      label: "Sign out",
      icon: LogOut,
      run: () => {
        logout()
          .finally(() => {
            window.location.href = "/login";
          })
          .catch(() => {});
      },
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      footer={null}
      closable={false}
      title={null}
      width={580}
      styles={{ body: { padding: 0 } }}
    >
      <CommandPrimitive
        className="flex h-full w-full flex-col overflow-hidden rounded-xl elev-2 border border-border bg-popover text-popover-foreground [&_[cmdk-group]]:overflow-hidden [&_[cmdk-group]]:p-1 [&_[cmdk-group]]:text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-item]]:relative [&_[cmdk-item]]:flex [&_[cmdk-item]]:cursor-default [&_[cmdk-item]]:gap-2 [&_[cmdk-item]]:select-none [&_[cmdk-item]]:items-center [&_[cmdk-item]]:rounded-sm [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]]:text-sm [&_[cmdk-item]]:outline-none [&_[cmdk-item][data-selected=true]]:bg-accent [&_[cmdk-item][data-selected=true]]:text-accent-foreground [&_[cmdk-item][data-disabled=true]]:pointer-events-none [&_[cmdk-item][data-disabled=true]]:opacity-50 [&_[cmdk-item]_svg]:pointer-events-none [&_[cmdk-item]_svg]:size-4 [&_[cmdk-item]_svg]:shrink-0 [&_[cmdk-separator]]:-mx-1 [&_[cmdk-separator]]:h-px [&_[cmdk-separator]]:bg-border"
        loop
      >
        <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
          <Search className="mr-2 h-5 w-5 shrink-0 opacity-50" />
          <CommandPrimitive.Input
            autoFocus
            placeholder="Search apps, pages, actions…"
            value={q}
            onValueChange={setQ}
            className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <CommandPrimitive.List className="max-h-[60vh] overflow-y-auto overflow-x-hidden">
          <CommandPrimitive.Empty className="py-6 text-center text-sm">
            No results.
          </CommandPrimitive.Empty>

          {!q && recent.length > 0 && (
            <CommandPrimitive.Group heading={t.palette.recent}>
              {recent.map((r) => {
                const nav = navItems.find((n) => n.to === r);
                if (!nav) return null;
                return (
                  <CommandPrimitive.Item key={r} onSelect={() => runNav(r)}>
                    <nav.icon className="size-4 mr-2" />
                    {t.nav[nav.key]}
                  </CommandPrimitive.Item>
                );
              })}
            </CommandPrimitive.Group>
          )}

          <CommandPrimitive.Group heading={t.palette.nav}>
            {navItems.map((it) => (
              <CommandPrimitive.Item
                key={it.to}
                onSelect={() => runNav(it.to)}
                value={`nav ${t.nav[it.key]} ${it.to}`}
              >
                <it.icon className="size-4 mr-2" />
                <span className="flex-1">{t.nav[it.key]}</span>
                <span className="text-xs text-muted-foreground">{it.to}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>

          <CommandPrimitive.Group heading={t.palette.actions}>
            {actions
              .filter((a) => !a.admin || user?.is_admin)
              .map((a) => (
                <CommandPrimitive.Item
                  key={a.id}
                  onSelect={() => {
                    a.run();
                    close();
                  }}
                  value={`action ${a.label}`}
                >
                  <a.icon className="size-3.5 mr-2 text-muted-foreground" />
                  <span>{a.label}</span>
                  {a.admin && (
                    <span className="ml-auto text-[11px] text-muted-foreground">admin</span>
                  )}
                </CommandPrimitive.Item>
              ))}
          </CommandPrimitive.Group>

          <CommandPrimitive.Separator />
          <CommandPrimitive.Group heading="Accent">
            {ACCENTS.map((a) => (
              <CommandPrimitive.Item
                key={a.id}
                onSelect={() => {
                  setAccent(a.id);
                  toast.success(`Accent: ${a.label}`);
                  close();
                }}
                value={`accent ${a.label}`}
              >
                <span className="size-3 rounded-full mr-2" style={{ background: a.color }} />
                <Palette className="size-3.5 mr-2 text-muted-foreground" />
                {a.label}
                {accent === a.id && (
                  <span className="ml-auto text-[11px] text-muted-foreground">current</span>
                )}
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>

          <CommandPrimitive.Separator />
          <CommandPrimitive.Group heading={t.palette.services}>
            {services.slice(0, 20).map((s) => (
              <CommandPrimitive.Item
                key={s.slug}
                onSelect={() => {
                  window.open(s.open_url, "_blank");
                  close();
                }}
                value={`svc ${s.name} ${s.slug} ${s.category}`}
              >
                <span
                  className="size-2 rounded-full mr-2"
                  style={{ background: s.icon_color ?? "var(--primary)" }}
                />
                <span className="flex-1">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.category}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>

          <CommandPrimitive.Group heading="Containers">
            {containers.slice(0, 15).map((c) => (
              <CommandPrimitive.Item
                key={c.id}
                onSelect={() => {
                  runNav(`/docker/${c.id}`);
                }}
                value={`container ${c.name} ${c.image}`}
              >
                <span
                  className="size-2 rounded-full mr-2"
                  style={{
                    background:
                      c.state === "running" ? "var(--success)" : "var(--muted-foreground)",
                  }}
                />
                <span className="flex-1">{c.name}</span>
                <span className="text-[11px] text-muted-foreground truncate max-w-[160px]">
                  {c.image}
                </span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>

          <CommandPrimitive.Group heading="Systemd units">
            {units.slice(0, 15).map((u) => {
              let severity: "ok" | "err" | "off" = "off";
              if (u.active === "active") {
                severity = "ok";
              } else if (u.active === "failed") {
                severity = "err";
              }
              return (
              <CommandPrimitive.Item
                key={u.name}
                onSelect={() => {
                  runNav(`/systemd/${u.name}`);
                }}
                value={`unit ${u.name} ${u.description}`}
              >
                <span
                  className={cn(
                    "size-2 rounded-full mr-2",
                    severityColor(severity).dot,
                  )}
                />
                <span className="flex-1 font-mono text-xs">{u.name}</span>
                <span className="text-[11px] text-muted-foreground truncate max-w-[160px]">
                  {u.description}
                </span>
              </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.Group>

          {user?.is_admin && (
            <CommandPrimitive.Group heading="Recent audit">
              {audit.slice(0, 8).map((a) => (
                <CommandPrimitive.Item
                  key={a.id}
                  onSelect={() => {
                    runNav("/audit");
                  }}
                  value={`audit ${a.tool} ${a.actor} ${a.decision_reason}`}
                >
                  <span
                    className="size-2 rounded-full mr-2"
                    style={{
                      background: a.decision === "allow" ? "var(--success)" : "var(--destructive)",
                    }}
                  />
                  <span className="flex-1 truncate">{a.tool}</span>
                  <span className="text-[11px] text-muted-foreground">{a.actor}</span>
                </CommandPrimitive.Item>
              ))}
            </CommandPrimitive.Group>
          )}
        </CommandPrimitive.List>
        <div className="border-t px-3 py-1.5 flex justify-between text-[11px] text-muted-foreground">
          <span>{t.palette.hints.move}</span>
          <span>{t.palette.hints.select}</span>
          <span>{t.palette.hints.close}</span>
        </div>
      </CommandPrimitive>
    </Modal>
  );
}
