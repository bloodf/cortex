/**
 * Approval action string constants — single source of truth for mint callsites.
 *
 * Why this file exists
 * --------------------
 * Pipeline-level `approval: true` gates hash the action string the UI mints
 * via `actionHashFor(action, payload)`. A typo or unwrapped template on the
 * mint side produces a token the gate cannot verify (HTTP 412). Keeping
 * gate strings here means callers import named constants instead of
 * re-typing literals.
 *
 * Token transport (C5, kept asymmetric by design)
 * -----------------------------------------------
 * Pipeline-level `approval: true` gates consume the token via the
 * `x-cortex-approval-token` HTTP header — these are the constants below.
 * Docker / Incus surface bridges consume the token from the body's
 * `input.approvalToken` field; the bridge hashes a separate policy name
 * (e.g. `` `incus.${action}` ``, `` `docker.${op}` ``). Unifying the two
 * pathways would break the bridge's policy-name separation (PB-4 / PB-5).
 *
 * See `src/server/approval/index.ts` for the mint allowlist and
 * `src/server/{incus,docker}/bridge.ts` for the bridge contract.
 */

export const APPROVAL_ACTIONS = {
  /** Pipeline gate: `systemd.actions.systemdAction` in `systemd.functions.ts`. */
  systemdAction: "systemd.action",
  /** Pipeline gate: `agents.functions.agentsAction`. */
  agentsAction: "agents.action",
  /** Pipeline gate: `agents.functions.setAgentModel`. */
  agentsModel: "agents.model",
  /** Pipeline gate: `processes.functions.killProcess`. */
  processesKill: "processes.kill",
  /** Pipeline gate: `docker.functions.dockerPrune`. Bridge-only (unused from UI). */
  dockerPrune: "docker.prune",
  /** Pipeline gate: `dependencies.functions.setServiceAutostart`. Payload = full input incl. `force`. */
  servicesAutostart: "services.autostart",
  /** Pipeline gate: `notes.functions.writeMdFile`. Payload = full input `{ path, content }`. */
  notesWrite: "notes.write",
} as const;

export type PipelineApprovalAction = (typeof APPROVAL_ACTIONS)[keyof typeof APPROVAL_ACTIONS];
