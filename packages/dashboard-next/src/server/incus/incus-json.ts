/**
 * Pure Incus-JSON mapping helpers.
 *
 * These transform raw `incus ... --format json` objects into the dashboard's
 * domain shapes. They are side-effect free (no I/O, no shared state) so they
 * can be unit-tested in isolation and are exercised through the bridge's
 * public API by `__tests__/bridge.test.ts`.
 */
import { type IncusInstance, type IncusImage, type IncusInstanceStatus } from "@cortexos/contracts";

/** Snapshot row stored in the mock. */
export interface MockInstanceRecord extends IncusInstance {
  /** Allowlist flag — gating the bridge's allowlist check. */
  allowlisted: boolean;
  /** Live state fields populated by `incus list` for the live view. */
  live?: {
    status: string;
    statusCode: IncusInstanceStatus;
    architecture: string;
    state: {
      networks: Record<
        string,
        {
          addresses: {
            family: "inet" | "inet6";
            address: string;
            scope?: "global" | "link" | "local";
          }[];
          state?: string;
          type?: string;
        }
      >;
      pid?: number;
    };
    profiles: string[];
    snapshots: { name: string; createdAt: string; stateful: boolean }[];
  };
}

/** Parse an Incus memory limit string into MiB. */
export function parseMemoryLimit(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|mib|gb|gib|tb|tib)?$/.exec(cleaned);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2] ?? "b";
  switch (unit) {
    case "b":
      return Math.round(num / (1024 * 1024));
    case "kb":
      return Math.round(num / 1024);
    case "mb":
    case "mib":
      return Math.round(num);
    case "gb":
    case "gib":
      return Math.round(num * 1024);
    case "tb":
    case "tib":
      return Math.round(num * 1024 * 1024);
    default:
      return Math.round(num);
  }
}

/** Parse an Incus CPU limit into an integer. */
export function parseCpuLimit(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+)$/.exec(value.trim());
  return m ? parseInt(m[1], 10) : null;
}

/** Map an Incus status string to the contracts IncusInstanceStatus. */
export function mapIncusStatus(status: string): IncusInstanceStatus {
  const s = status.toLowerCase();
  switch (s) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "frozen":
      return "frozen";
    case "error":
      return "error";
    case "starting":
      return "provisioning";
    case "stopping":
      return "active";
    default:
      return "active";
  }
}

/** Map an Incus type string to the contracts IncusInstanceType. */
export function mapIncusType(type: string): IncusInstance["type"] {
  if (type === "virtual-machine") return "vm";
  return "container";
}

/** Map an Incus image type string to the contracts image type. */
export function mapIncusImageType(type: string): IncusImage["type"] {
  if (type === "virtual-machine") return "virtual-machine";
  if (type === "container") return "container";
  return "unknown";
}

/** Extract bridge from expanded devices. */
export function extractBridge(devices: Record<string, unknown>): string {
  const nic = Object.values(devices).find(
    (dev) =>
      dev &&
      typeof dev === "object" &&
      (dev as Record<string, unknown>).type === "nic" &&
      (typeof (dev as Record<string, unknown>).network === "string" ||
        typeof (dev as Record<string, unknown>).parent === "string"),
  ) as Record<string, unknown> | undefined;
  if (nic) {
    return ((nic.network as string | undefined) ?? (nic.parent as string | undefined)) as string;
  }
  return "incusbr0";
}

/** Extract pool from expanded devices. */
export function extractPool(devices: Record<string, unknown>): string {
  const disk = Object.values(devices).find(
    (dev) =>
      dev &&
      typeof dev === "object" &&
      (dev as Record<string, unknown>).type === "disk" &&
      (dev as Record<string, unknown>).path === "/" &&
      typeof (dev as Record<string, unknown>).pool === "string",
  ) as Record<string, unknown> | undefined;
  if (disk) return disk.pool as string;
  return "default";
}

/** Map a single Incus list JSON entry to MockInstanceRecord. */
export function mapIncusJsonToMockRecord(item: Record<string, unknown>): MockInstanceRecord {
  const config = (item.config as Record<string, string>) ?? {};
  const imageName =
    config["image.name"] || config["image.description"] || config["image.os"] || "unknown";
  const type = mapIncusType(String(item.type ?? "container"));
  const status = mapIncusStatus(String(item.status ?? "Stopped"));
  const devices =
    (item.expanded_devices as Record<string, unknown>) ??
    (item.devices as Record<string, unknown>) ??
    {};
  const bridge = extractBridge(devices);
  const pool = extractPool(devices);
  const profiles = Array.isArray(item.profiles) ? (item.profiles as string[]) : [];

  const state = (item?.state as Record<string, unknown>) ?? {};
  const networks: NonNullable<MockInstanceRecord["live"]>["state"]["networks"] = {};
  const netState = state.network as Record<string, unknown> | undefined;
  if (netState && typeof netState === "object") {
    Object.entries(netState).forEach(([ifName, ifData]) => {
      if (!ifData || typeof ifData !== "object") return;
      const iface = ifData as Record<string, unknown>;
      const addrs: {
        family: "inet" | "inet6";
        address: string;
        scope?: "global" | "link" | "local";
      }[] = [];
      const addrList = Array.isArray(iface.addresses) ? iface.addresses : [];
      addrList.forEach((a) => {
        if (!a || typeof a !== "object") return;
        const addr = a as Record<string, unknown>;
        const family = String(addr.family ?? "");
        const address = String(addr.address ?? "");
        if (!address) return;
        if (family === "inet" || family === "inet6") {
          addrs.push({
            family,
            address,
            scope: String(addr.scope ?? "global") as "global" | "link" | "local",
          });
        }
      });
      networks[ifName] = {
        addresses: addrs,
        state: typeof iface.state === "string" ? iface.state : undefined,
        type: typeof iface.type === "string" ? iface.type : undefined,
      };
    });
  }

  return {
    name: String(item.name ?? ""),
    slug: String(item.name ?? ""),
    status,
    type,
    image: imageName,
    cpu: parseCpuLimit(config["limits.cpu"]),
    memory: parseMemoryLimit(config["limits.memory"]),
    config: {
      target: {
        mode: "new",
        ghOrg: "",
        slug: String(item.name ?? ""),
        branch: "main",
      },
      image: {
        alias: imageName,
        gastown: false,
        profiles,
        pool,
      },
      hermes: {
        enabled: false,
        proxies: [],
      },
      network: {
        bridge,
        tailscale: false,
        webAccess: false,
      },
    },
    devices,
    lastValidation: null,
    createdBy: "00000000-0000-4000-8000-000000000000",
    createdAt: String(item.created_at ?? new Date().toISOString()),
    updatedAt: String(item.last_used_at ?? item.created_at ?? new Date().toISOString()),
    allowlisted: true,
    live: {
      status: String(item.status ?? "Stopped").toUpperCase(),
      statusCode: status,
      architecture: String(item.architecture ?? "x86_64"),
      state: {
        networks,
        pid: typeof state.pid === "number" ? state.pid : 0,
      },
      profiles,
      snapshots: [],
    },
  };
}
