import type { LucideIcon } from "lucide-react";
import {
  Activity,
  LayoutGrid,
  HeartPulse,
  Bot,
  Container,
  Boxes,
  Server,
  HardDrive,
  Network,
  Cpu,
  Terminal,
  Mail,
  Bell,
  CheckCircle2,
  ScrollText,
  Settings2,
  BadgeCheck,
  FileKey,
  Clock,
  Database,
  Waypoints,
  Search,
  NotebookPen,
  Plug,
} from "lucide-react";

export type NavKey =
  | "overview"
  | "apps"
  | "healthcheck"
  | "agents"
  | "docker"
  | "incus"
  | "systemd"
  | "storage"
  | "network"
  | "processes"
  | "terminal"
  | "mail"
  | "alerts"
  | "approvals"
  | "audit"
  | "services"
  | "badges"
  | "env"
  | "projects"
  | "scheduler"
  | "backups"
  | "dependencies"
  | "docker_search"
  | "notes"
  | "mcps";

export interface NavItem {
  to: string;
  key: NavKey;
  icon: LucideIcon;
}
export type GroupId = "platform" | "infra" | "secOps" | "admin";
export interface NavGroup {
  id: GroupId;
  items: NavItem[];
  adminOnly?: boolean;
}

export const PINNED: NavItem = { to: "/overview", key: "overview", icon: Activity };

export const NAV: NavGroup[] = [
  {
    id: "platform",
    items: [
      { to: "/apps", key: "apps", icon: LayoutGrid },
      { to: "/agents", key: "agents", icon: Bot },
      { to: "/notes", key: "notes", icon: NotebookPen },
    ],
  },
  {
    id: "infra",
    items: [
      { to: "/docker", key: "docker", icon: Container },
      { to: "/docker-search", key: "docker_search", icon: Search },
      { to: "/incus", key: "incus", icon: Boxes },
      { to: "/systemd", key: "systemd", icon: Server },
      { to: "/storage", key: "storage", icon: HardDrive },
      { to: "/network", key: "network", icon: Network },
      { to: "/processes", key: "processes", icon: Cpu },
      { to: "/dependencies", key: "dependencies", icon: Waypoints },
      { to: "/terminal", key: "terminal", icon: Terminal },
      { to: "/mcps", key: "mcps", icon: Plug },
      { to: "/scheduler", key: "scheduler", icon: Clock },
      { to: "/backups", key: "backups", icon: Database },
    ],
  },
  {
    id: "secOps",
    items: [
      { to: "/mail-guardian", key: "mail", icon: Mail },
      { to: "/alerts", key: "alerts", icon: Bell },
      { to: "/approvals", key: "approvals", icon: CheckCircle2 },
      { to: "/audit", key: "audit", icon: ScrollText },
    ],
  },
  {
    id: "admin",
    adminOnly: true,
    items: [
      { to: "/admin/services", key: "services", icon: Settings2 },
      { to: "/admin/badges", key: "badges", icon: BadgeCheck },
      { to: "/admin/env-browser", key: "env", icon: FileKey },
    ],
  },
];

export const MOBILE_TABS = [
  { to: "/overview", key: "overview" as const, icon: Activity },
  { to: "/apps", key: "apps" as const, icon: LayoutGrid },
  { to: "/healthcheck", key: "healthcheck" as const, icon: HeartPulse },
  { to: "/docker", key: "docker" as const, icon: Container },
  { to: "/terminal", key: "terminal" as const, icon: Terminal },
];
