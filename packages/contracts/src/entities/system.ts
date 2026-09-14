/**
 * System / host metrics entities.
 *
 * The dashboard polls `/api/system`, `/api/network`, `/api/processes` from
 * the host. These types mirror the production `lib/sys-pilot/types.ts`
 * shapes with a few tightening rules (e.g. enum-string statuses instead of
 * free-form strings).
 *
 * @module
 */
import { z } from 'zod';
import { zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// System data (CPU, memory, drives, mounts, load, sensors)
// ---------------------------------------------------------------------------

export const MemorySchema = z.object({
  /** Percent used (0-100). */
  percent: z.number().min(0).max(100),
  used: z.number().int().min(0),
  total: z.number().int().min(0),
  free: z.number().int().min(0),
});
export type Memory = z.infer<typeof MemorySchema>;

export const DriveInfoSchema = z.object({
  name: z.string().min(1).max(64),
  model: z.string().max(256).nullable().optional(),
  /** Bytes; the legacy route returns a string — the schema is the stricter
   *  one and a small adapter converts. */
  size: z.number().int().min(0).nullable().optional(),
  type: z.string().max(32).nullable().optional(),
  mount: z.string().max(256).nullable().optional(),
  used: z.number().int().min(0).nullable().optional(),
  total: z.number().int().min(0).nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
});
export type DriveInfo = z.infer<typeof DriveInfoSchema>;

export const MountInfoSchema = z.object({
  filesystem: z.string().min(1).max(256),
  mount: z.string().min(1).max(256),
  total: z.number().int().min(0),
  used: z.number().int().min(0),
  free: z.number().int().min(0),
  percent: z.number().min(0).max(100),
});
export type MountInfo = z.infer<typeof MountInfoSchema>;

export const MachineSensorSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  value: z.number(),
  unit: z.enum(['celsius', 'rpm', 'volts', 'percent', 'unknown']),
  source: z.string().max(64).nullable().optional(),
});
export type MachineSensor = z.infer<typeof MachineSensorSchema>;

export const SystemDataSchema = z.object({
  /** CPU percent (0-100). */
  cpu: z.number().min(0).max(100).nullable(),
  memory: MemorySchema,
  drives: z.array(DriveInfoSchema).default([]),
  mounts: z.array(MountInfoSchema).default([]),
  /** 1, 5, 15-minute load averages. */
  load: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]),
  /** Uptime in seconds. */
  uptime: z.number().int().min(0),
  sensors: z
    .object({
      cpuTemperature: z.number().nullable().optional(),
      temperatures: z.array(MachineSensorSchema).default([]),
      fans: z.array(MachineSensorSchema).default([]),
      voltages: z.array(MachineSensorSchema).default([]),
    })
    .default({ temperatures: [], fans: [], voltages: [] }),
  timestamp: zIsoTimestamp,
});
export type SystemData = z.infer<typeof SystemDataSchema>;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const NetworkInterfaceSchema = z.object({
  name: z.string().min(1).max(32),
  /** Kbps (rolling 1s window). */
  rxKbps: z.number().min(0),
  txKbps: z.number().min(0),
  /** Cumulative bytes since boot. */
  rxBytesTotal: z.number().int().min(0),
  txBytesTotal: z.number().int().min(0),
});
export type NetworkInterface = z.infer<typeof NetworkInterfaceSchema>;

export const NetworkDataSchema = z.object({
  interfaces: z.array(NetworkInterfaceSchema).default([]),
  timestamp: zIsoTimestamp,
});
export type NetworkData = z.infer<typeof NetworkDataSchema>;

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export const ProcessInfoSchema = z.object({
  pid: z.number().int().min(1).max(4_194_304),
  ppid: z.number().int().min(0).max(4_194_304).nullable().optional(),
  user: z.string().min(0).max(64),
  /** 0-100 * num_cores (ps convention; can exceed 100). */
  cpu: z.number().min(0),
  /** 0-100. */
  mem: z.number().min(0).max(100),
  command: z.string().min(0).max(8192),
  startedAt: zIsoTimestamp.nullable().optional(),
});
export type ProcessInfo = z.infer<typeof ProcessInfoSchema>;
