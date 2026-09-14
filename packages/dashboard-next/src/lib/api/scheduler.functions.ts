/**
 * Scheduler — server functions (MP-024a).
 *
 * Transport is createServerFn RPC (ADR-001). The gate carries auth/RBAC/audit
 * and dynamically imports the server-only scheduler bridge so the client bundle
 * never pulls in `src/server/**`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";
import type { SchedulerJob } from "@/mocks/types";
import type { TimerRow } from "@/server/scheduler";

function toSchedulerJob(t: TimerRow): SchedulerJob {
  let status: SchedulerJob["status"];
  if (!t.enabled) status = "paused";
  else if (t.state === "failed") status = "failing";
  else status = "ok";

  return {
    id: t.name,
    name: t.description || t.name,
    cron: t.schedule || "—",
    target: t.target,
    lastRun: t.lastRun ?? "",
    nextRun: t.nextRun ?? "",
    status,
    durationMs: 0,
    enabled: t.enabled,
  };
}

// ---------------------------------------------------------------------------
// listSchedulerJobs — GET, auth: any → { jobs: SchedulerJob[] }
// ---------------------------------------------------------------------------

const listSchedulerJobsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  surface: "scheduler",
  action: "scheduler.list",
  handler: async () => {
    const { listTimers } = await import("@/server/scheduler");
    const timers = await listTimers();
    const jobs = timers.map(toSchedulerJob);
    return { jobs };
  },
});

export const listSchedulerJobs = createServerFn({ method: "GET" })
  .middleware([listSchedulerJobsGate])
  .handler(serverFnNoop);

export type { SchedulerJob };
