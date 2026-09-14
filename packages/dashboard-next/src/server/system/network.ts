/**
 * Network reader — WP-14.
 *
 * Returns only PHYSICAL NICs: those where /sys/class/net/<iface>/device exists.
 * Virtual interfaces (lo, docker*, veth*, br-*, incusbr*, tailscale*, wg*, cni*)
 * have no `device` symlink and are excluded.
 *
 * Delta rx/tx kbps is computed against the module-level `prev` map (first call
 * always returns 0 kbps for both — correct legacy behaviour).
 */

import fs from "node:fs";
import type { NetworkInterface, NetworkData } from "./types";

interface Sample {
  rx: number;
  tx: number;
  ts: number;
}

const prev = new Map<string, Sample>();

/**
 * A NIC is physical iff /sys/class/net/<name>/device exists (PCI/USB hardware).
 * Virtual interfaces created by the kernel, Docker, Incus, Tailscale, WireGuard,
 * or CNI plugins lack this symlink.
 */
export function isPhysicalInterface(name: string): boolean {
  try {
    fs.accessSync(`/sys/class/net/${name}/device`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a single /proc/net/dev data line (after the colon) and return rx/tx bytes.
 * Returns null if the line is malformed.
 * Exported for unit testing the pure parsing logic without fs mocking.
 */
export function parseProcNetDevLine(
  name: string,
  dataPart: string,
): { name: string; rx: number; tx: number } | null {
  if (!name || !dataPart) return null;
  // /proc/net/dev columns after the colon (space-separated):
  // rx: bytes pkts errs drop fifo frame compressed multicast
  // tx: bytes pkts errs drop fifo colls carrier compressed
  const cols = dataPart
    .trim()
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10));
  const rx = cols[0] ?? 0;
  const tx = cols[8] ?? 0;
  return { name, rx, tx };
}

/**
 * Filter virtual interface names from a list.
 * An interface is PHYSICAL iff /sys/class/net/<name>/device exists.
 * This is the same check used in the legacy network handler — exported for
 * direct unit testing without /proc/net/dev file access.
 */
export function filterPhysicalNames(names: string[]): string[] {
  return names.filter(isPhysicalInterface);
}

/**
 * Read /proc/net/dev and return stats for every physical NIC.
 * Returns an empty array on any error (non-Linux, permission, etc.).
 */
export function readNetworkInterfaces(): NetworkInterface[] {
  try {
    const raw = fs.readFileSync("/proc/net/dev", "utf8");
    const lines = raw.split("\n");
    // First 2 lines are headers; data starts at index 2.
    const interfaces = lines.slice(2).reduce<NetworkInterface[]>((acc, line) => {
      if (!line) return acc;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return acc;
      const name = line.slice(0, colonIdx).trim();
      const dataPart = line.slice(colonIdx + 1);
      if (!name || !dataPart) return acc;
      if (!isPhysicalInterface(name)) return acc;
      const parsed = parseProcNetDevLine(name, dataPart);
      if (!parsed) return acc;
      const { rx, tx } = parsed;
      const now = Date.now();
      const last = prev.get(name);
      let rxKbps = 0;
      let txKbps = 0;
      if (last) {
        const sec = Math.max(1, (now - last.ts) / 1000);
        rxKbps = Math.max(0, (rx - last.rx) / 1024 / sec);
        txKbps = Math.max(0, (tx - last.tx) / 1024 / sec);
      }
      prev.set(name, { rx, tx, ts: now });
      acc.push({ name, rxKbps, txKbps, rxBytesTotal: rx, txBytesTotal: tx });
      return acc;
    }, []);
    return interfaces;
  } catch {
    return [];
  }
}

export function getNetworkData(): NetworkData {
  return { interfaces: readNetworkInterfaces() };
}
