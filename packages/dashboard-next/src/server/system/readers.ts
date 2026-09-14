/**
 * System readers — WP-14.
 *
 * Consolidates CPU, memory, drives, mounts, and sensors readers.
 * Ported verbatim from legacy `packages/dashboard/src/routes/api/system/+server.ts`,
 * updating only Node built-in import style (node:*).
 *
 * All sub-readers catch internally — collectSystem() always returns a valid shape.
 */

import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriveInfo, MachineSensor, MountInfo, SystemData } from "./types";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// CPU percent — module-level delta state (first call returns 0)
// ---------------------------------------------------------------------------

let prevCpu: { total: number; idle: number } | null = null;

export function getCpuPercent(): number {
  try {
    const raw = fs.readFileSync("/proc/stat", "utf8");
    const line = raw.split("\n")[0];
    if (!line) return 0;
    const parts = line
      .split(/\s+/)
      .slice(1)
      .map((s) => Number.parseInt(s, 10));
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + b, 0);
    if (!prevCpu) {
      prevCpu = { total, idle };
      return 0;
    }
    const dTotal = total - prevCpu.total;
    const dIdle = idle - prevCpu.idle;
    prevCpu = { total, idle };
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function getMemory(): SystemData["memory"] {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    used,
    percent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Drives — lsblk, type=disk only (physical block devices)
// ---------------------------------------------------------------------------

function readSys(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

export async function getDrives(): Promise<DriveInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "lsblk",
      ["-J", "-b", "-o", "NAME,MODEL,SIZE,TYPE,MOUNTPOINT"],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as { blockdevices?: unknown[] };
    const out: DriveInfo[] = [];
    function walk(nodes: unknown[]) {
      nodes.forEach((n) => {
        if (!n || typeof n !== "object") return;
        const node = n as Record<string, unknown>;
        if (node.type === "disk") {
          out.push({
            name: `/dev/${String(node.name ?? "unknown")}`,
            model: String(node.model ?? ""),
            size: Number(node.size) || 0,
          });
        }
        if (Array.isArray(node.children)) walk(node.children);
      });
    }
    if (Array.isArray(data.blockdevices)) walk(data.blockdevices);
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mounts — df, excluding virtual filesystems
// Physical mounts only: exclude tmpfs, devtmpfs, squashfs, overlay
// ---------------------------------------------------------------------------

export async function getMounts(): Promise<MountInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "df",
      [
        "-B1",
        "-T",
        "--exclude-type=tmpfs",
        "--exclude-type=devtmpfs",
        "--exclude-type=squashfs",
        "--exclude-type=overlay",
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = stdout.trim().split("\n");
    // With -T: Filesystem Type 1B-blocks Used Available Use% Mounted-on (7+ cols)
    const out = lines.slice(1).reduce<MountInfo[]>((acc, line) => {
      if (!line) return acc;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) return acc;
      const total = Number(parts[2]);
      const used = Number(parts[3]);
      const free = Number(parts[4]);
      const percentStr = parts[5];
      const mount = parts[6];
      if (!mount) return acc;
      const pct = Number(percentStr?.replace("%", ""));
      acc.push({
        filesystem: parts[0] ?? "",
        mount,
        total: Number.isFinite(total) ? total : 0,
        used: Number.isFinite(used) ? used : 0,
        free: Number.isFinite(free) ? free : 0,
        percent: Number.isFinite(pct) ? pct : 0,
      });
      return acc;
    }, []);
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sensors — /sys/class/thermal/* and /sys/class/hwmon/*
// ---------------------------------------------------------------------------

export function getSensors(): SystemData["sensors"] {
  const temperatures: MachineSensor[] = [];
  const fans: MachineSensor[] = [];
  const voltages: MachineSensor[] = [];

  // Thermal zones
  try {
    const zones = fs.readdirSync("/sys/class/thermal");
    zones.forEach((z) => {
      if (!z.startsWith("thermal_zone")) return;
      const type = readSys(`/sys/class/thermal/${z}/type`) ?? z;
      const raw = readSys(`/sys/class/thermal/${z}/temp`);
      const val = raw ? Number(raw) / 1000 : NaN;
      if (Number.isFinite(val)) {
        temperatures.push({ id: z, label: type, value: val, unit: "celsius", source: "thermal" });
      }
    });
  } catch {
    // /sys/class/thermal may not exist on all hosts
  }

  // hwmon — temperature, fan, voltage inputs
  try {
    const hwmon = fs.readdirSync("/sys/class/hwmon");
    hwmon.forEach((h) => {
      const name = readSys(`/sys/class/hwmon/${h}/name`) ?? h;
      const dir = `/sys/class/hwmon/${h}`;
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      entries.forEach((f) => {
        const mTemp = /^temp(\d+)_input$/.exec(f);
        if (mTemp) {
          const idx = mTemp[1];
          if (!idx) return;
          const label = readSys(`${dir}/temp${idx}_label`) ?? `${name} temp${idx}`;
          const raw = readSys(`${dir}/temp${idx}_input`);
          const val = raw ? Number(raw) / 1000 : NaN;
          if (Number.isFinite(val)) {
            temperatures.push({
              id: `${h}-${idx}`,
              label,
              value: val,
              unit: "celsius",
              source: "hwmon",
            });
          }
        }
        const mFan = /^fan(\d+)_input$/.exec(f);
        if (mFan) {
          const idx = mFan[1];
          if (!idx) return;
          const label = readSys(`${dir}/fan${idx}_label`) ?? `${name} fan${idx}`;
          const raw = readSys(`${dir}/fan${idx}_input`);
          const val = raw ? Number(raw) : NaN;
          if (Number.isFinite(val)) {
            fans.push({ id: `${h}-${idx}`, label, value: val, unit: "rpm", source: "hwmon" });
          }
        }
        const mIn = /^in(\d+)_input$/.exec(f);
        if (mIn) {
          const idx = mIn[1];
          if (!idx) return;
          const label = readSys(`${dir}/in${idx}_label`) ?? `${name} in${idx}`;
          const raw = readSys(`${dir}/in${idx}_input`);
          const val = raw ? Number(raw) / 1000 : NaN;
          if (Number.isFinite(val)) {
            voltages.push({ id: `${h}-${idx}`, label, value: val, unit: "volts", source: "hwmon" });
          }
        }
      });
    });
  } catch {
    // /sys/class/hwmon may not exist on all hosts
  }

  const cpuTemperature =
    temperatures.find((t) => /cpu|x86|coretemp|k10temp/i.test(t.label)) ?? temperatures[0] ?? null;
  return { cpuTemperature, temperatures, fans, voltages };
}

// ---------------------------------------------------------------------------
// collectSystem — runs all readers in parallel, merges mount info into drives
// ---------------------------------------------------------------------------

export async function collectSystem(): Promise<SystemData> {
  const [drives, mounts] = await Promise.all([getDrives(), getMounts()]);
  // Annotate drives with mount/used/total/percent from matching mount entries.
  mounts.forEach((m) => {
    const d = drives.find((drive) => m.filesystem.startsWith(drive.name));
    if (d) {
      d.mount = m.mount;
      d.used = m.used;
      d.total = m.total;
      d.percent = m.percent;
    }
  });
  return {
    cpu: getCpuPercent(),
    memory: getMemory(),
    drives,
    mounts,
    load: os.loadavg(),
    uptime: os.uptime(),
    sensors: getSensors(),
  };
}
