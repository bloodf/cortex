import type { ReactNode } from "react";
import {
  Activity,
  Cpu,
  MemoryStick,
  HardDrive,
  Thermometer,
  Clock,
  Container,
  Boxes,
  Database,
  BarChart3,
  Wifi,
  AlertTriangle,
} from "lucide-react";
import {
  CpuW,
  MemW,
  StorageW,
  CpuTempW,
  ServicesW,
  UptimeW,
  DockerW,
  IncusW,
  LiveTrendW,
  SensorsW,
  ProcessesW,
  NetworkW,
  AlertsW,
  DbW,
  MonW,
  DrivesW,
} from "./widgets";

export interface WidgetSpec {
  id: string;
  title: string;
  icon: typeof Activity;
  default: { w: number; h: number };
  min: { w: number; h: number };
  render: () => ReactNode;
}

// ── Widget catalog ────────────────────────────────────────────
// Standardized sizing rules (12-col grid, rowHeight 56):
//  - Small stat (single number):  default 2x2,  min 2x2
//  - Wide stat with trend:        default 4x2,  min 4x2
//  - Compact list:                default 4x4,  min 3x3
//  - Charts / detailed lists:     default 6x5,  min 4x4
//  - Wide tables:                 default 8x5,  min 5x4
export const WIDGETS: WidgetSpec[] = [
  {
    id: "cpu",
    title: "CPU",
    icon: Cpu,
    default: { w: 4, h: 2 },
    min: { w: 4, h: 2 },
    render: () => <CpuW />,
  },
  {
    id: "memory",
    title: "Memory",
    icon: MemoryStick,
    default: { w: 4, h: 2 },
    min: { w: 4, h: 2 },
    render: () => <MemW />,
  },
  {
    id: "storage",
    title: "Storage",
    icon: HardDrive,
    default: { w: 2, h: 2 },
    min: { w: 2, h: 2 },
    render: () => <StorageW />,
  },
  {
    id: "cpu-temp",
    title: "CPU Temp",
    icon: Thermometer,
    default: { w: 2, h: 2 },
    min: { w: 2, h: 2 },
    render: () => <CpuTempW />,
  },
  {
    id: "services",
    title: "Services",
    icon: Activity,
    default: { w: 2, h: 2 },
    min: { w: 2, h: 2 },
    render: () => <ServicesW />,
  },
  {
    id: "uptime",
    title: "Uptime",
    icon: Clock,
    default: { w: 2, h: 2 },
    min: { w: 2, h: 2 },
    render: () => <UptimeW />,
  },
  {
    id: "docker",
    title: "Docker",
    icon: Container,
    default: { w: 2, h: 2 },
    min: { w: 2, h: 2 },
    render: () => <DockerW />,
  },
  {
    id: "incus",
    title: "Incus",
    icon: Boxes,
    default: { w: 2, h: 2 },
    min: { w: 2, h: 2 },
    render: () => <IncusW />,
  },
  {
    id: "live",
    title: "Live performance",
    icon: Activity,
    default: { w: 8, h: 5 },
    min: { w: 5, h: 4 },
    render: () => <LiveTrendW />,
  },
  {
    id: "sensors",
    title: "Sensors",
    icon: Thermometer,
    default: { w: 4, h: 2 },
    min: { w: 4, h: 2 },
    render: () => <SensorsW />,
  },
  {
    id: "processes",
    title: "Top processes",
    icon: Cpu,
    default: { w: 8, h: 5 },
    min: { w: 5, h: 4 },
    render: () => <ProcessesW />,
  },
  {
    id: "network",
    title: "Network",
    icon: Wifi,
    default: { w: 8, h: 5 },
    min: { w: 6, h: 4 },
    render: () => <NetworkW />,
  },
  {
    id: "alerts",
    title: "Recent alerts",
    icon: AlertTriangle,
    default: { w: 4, h: 4 },
    min: { w: 3, h: 3 },
    render: () => <AlertsW />,
  },
  {
    id: "db",
    title: "Databases",
    icon: Database,
    default: { w: 4, h: 4 },
    min: { w: 3, h: 3 },
    render: () => <DbW />,
  },
  {
    id: "mon",
    title: "Monitoring",
    icon: BarChart3,
    default: { w: 4, h: 4 },
    min: { w: 3, h: 3 },
    render: () => <MonW />,
  },
  {
    id: "drives",
    title: "Drives",
    icon: HardDrive,
    default: { w: 6, h: 4 },
    min: { w: 4, h: 3 },
    render: () => <DrivesW />,
  },
];

export const WIDGET_MAP: Record<string, WidgetSpec> = Object.fromEntries(
  WIDGETS.map((w) => [w.id, w]),
);

export const DEFAULT_LAYOUT: { i: string; x: number; y: number; w: number; h: number }[] = [
  // Row 1 — primary stats
  { i: "cpu", x: 0, y: 0, w: 4, h: 2 },
  { i: "memory", x: 4, y: 0, w: 4, h: 2 },
  { i: "storage", x: 8, y: 0, w: 2, h: 2 },
  { i: "cpu-temp", x: 10, y: 0, w: 2, h: 2 },
  // Row 2 — small stats (all uniform 2x2)
  { i: "uptime", x: 0, y: 2, w: 2, h: 2 },
  { i: "docker", x: 2, y: 2, w: 2, h: 2 },
  { i: "incus", x: 4, y: 2, w: 2, h: 2 },
  { i: "services", x: 6, y: 2, w: 2, h: 2 },
  // Sensors fills remainder of row 2 (4 wide, 2 tall, two-column inside)
  { i: "sensors", x: 8, y: 2, w: 4, h: 2 },
  // Row 3 — charts
  { i: "live", x: 0, y: 4, w: 8, h: 5 },
  { i: "network", x: 0, y: 9, w: 8, h: 5 },
  { i: "alerts", x: 8, y: 4, w: 4, h: 6 },
  // Row 4 — detail
  { i: "processes", x: 0, y: 14, w: 8, h: 5 },
  { i: "drives", x: 8, y: 10, w: 4, h: 5 },
];
