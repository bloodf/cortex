/**
 * Health module barrel (WP-10).
 *
 * `startHealthScheduler` is wired into `bootRuntime()` (src/server/runtime.ts)
 * so it runs exactly once per server boot. `probe` is reused by the manual
 * recheck server fn so a recheck uses the same probe logic as the scheduler.
 */

export { startHealthScheduler, sweepOnce, probe } from "./scheduler";
export type { ProbeResult, ProbeStatus } from "./scheduler";
