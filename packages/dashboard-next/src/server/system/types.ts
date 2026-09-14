/**
 * Local type definitions for WP-14 system/network/processes/storage server readers.
 * Mirrors the legacy `$lib/types/dashboard` shapes used by the four API handlers.
 */

export interface MachineSensor {
  id: string;
  label: string;
  value: number;
  unit: string;
  source: string;
}

export interface DriveInfo {
  name: string;
  model: string;
  size: number;
  mount?: string;
  used?: number;
  total?: number;
  percent?: number;
}

export interface MountInfo {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  free: number;
  percent: number;
}

export interface SystemData {
  cpu: number;
  memory: {
    total: number;
    used: number;
    percent: number;
  };
  drives: DriveInfo[];
  mounts: MountInfo[];
  load: number[];
  uptime: number;
  sensors: {
    cpuTemperature: MachineSensor | null;
    temperatures: MachineSensor[];
    fans: MachineSensor[];
    voltages: MachineSensor[];
  };
}

export interface NetworkInterface {
  name: string;
  rxKbps: number;
  txKbps: number;
  rxBytesTotal: number;
  txBytesTotal: number;
}

export interface NetworkData {
  interfaces: NetworkInterface[];
}

export interface ProcessInfo {
  pid: number;
  user: string;
  command: string;
  cpu: number;
  mem: number;
}
