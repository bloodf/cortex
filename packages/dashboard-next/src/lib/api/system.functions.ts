/**
 * System / Network / Processes / Storage — server functions (WP-14).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic
 * (readers, /proc, /sys, lsblk, df, ps) is imported DYNAMICALLY inside each
 * handler so import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/system/+server.ts          (system)
 *   packages/dashboard/src/routes/api/network/+server.ts         (network)
 *   packages/dashboard/src/routes/api/processes/+server.ts       (processes)
 *   packages/dashboard/src/routes/(authed)/storage/+page.server.ts (storage)
 *
 * Physical-filter rules (enforced in the readers):
 *   - Network: only NICs where /sys/class/net/<name>/device exists.
 *   - Storage: only lsblk type=disk; mounts excluding tmpfs/devtmpfs/squashfs/overlay.
 *
 * Frontend (Wave 2) calls these typed:
 *   await getSystem({ data: {} })
 *   await getNetwork({ data: {} })
 *   await getProcesses({ data: {} })
 *   await getStorage({ data: {} })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// All four functions take no meaningful input — empty strict object.
const EmptyInput = z.object({}).strict();

// ---------------------------------------------------------------------------
// getSystem — GET, auth: any → SystemData
// ---------------------------------------------------------------------------

const systemGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: EmptyInput,
  surface: "system",
  action: "system.read",
  handler: async () => {
    const { collectSystem } = await import("@/server/system/readers");
    return collectSystem();
  },
});
export const getSystem = createServerFn({ method: "GET" })
  .middleware([systemGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getNetwork — GET, auth: any → { interfaces: NetworkInterface[] }
// Only physical NICs (those with /sys/class/net/<name>/device).
// ---------------------------------------------------------------------------

const networkGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: EmptyInput,
  surface: "system",
  action: "network.read",
  handler: async () => {
    const { getNetworkData } = await import("@/server/system/network");
    return getNetworkData();
  },
});
export const getNetwork = createServerFn({ method: "GET" })
  .middleware([networkGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getProcesses — GET, auth: any → { processes: ProcessInfo[] }
// ---------------------------------------------------------------------------

const processesGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: EmptyInput,
  surface: "system",
  action: "processes.list",
  handler: async () => {
    const { readProcesses } = await import("@/server/system/processes");
    const processes = await readProcesses();
    return { processes };
  },
});
export const getProcesses = createServerFn({ method: "GET" })
  .middleware([processesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getStorage — GET, auth: any → { disks: DriveInfo[], mounts: MountInfo[] }
// Physical disks only (lsblk type=disk); mounts excluding tmpfs/devtmpfs/squashfs/overlay.
// ---------------------------------------------------------------------------

const storageGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: EmptyInput,
  surface: "system",
  action: "storage.read",
  handler: async () => {
    const { getDrives, getMounts } = await import("@/server/system/readers");
    const [disks, mounts] = await Promise.all([getDrives(), getMounts()]);
    return { disks, mounts };
  },
});
export const getStorage = createServerFn({ method: "GET" })
  .middleware([storageGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// killProcess — POST, auth: admin, rate-limit 20/min/user → { ok: true }
// Destructive: sends SIGTERM (default) or SIGKILL to a PID. The bridge refuses
// PID <= 1 and the dashboard's own process; the UI gates it behind a confirm.
// ---------------------------------------------------------------------------

const KillProcessInput = z
  .object({
    pid: z.coerce.number().int().positive(),
    signal: z.enum(["SIGTERM", "SIGKILL"]).default("SIGTERM"),
  })
  .strict();

type KillProcessInputT = z.infer<typeof KillProcessInput>;

/**
 * killProcess gate options. Exported so the node-env test drives the REAL gate
 * through the pipeline. `approval: true` for parity with every other
 * destructive op (docker/incus/systemd/agents actions all require a single-use
 * approval token) — signalling an arbitrary PID is at least as dangerous.
 */
export const killProcessGateOptions: ServerFnOptions<KillProcessInputT, { ok: true }> = {
  method: "POST",
  auth: "admin",
  input: KillProcessInput,
  rateLimit: { limit: 20, windowSec: 60, bucket: "user" },
  approval: true,
  surface: "system",
  action: "processes.kill",
  target: (input) => `${input.signal}:${input.pid}`,
  handler: async ({ input }) => {
    const { killProcess: doKill } = await import("@/server/system/processes");
    const { validationError } = await import("@/server/errors/types");
    try {
      doKill(input.pid, input.signal);
    } catch (e) {
      throw validationError(e instanceof Error ? e.message : "Failed to signal process", []);
    }
    return { ok: true } as const;
  },
};
const killProcessGate = defineServerFn(killProcessGateOptions);
export const killProcess = createServerFn({ method: "POST" })
  .middleware([killProcessGate])
  .handler(serverFnNoop);
