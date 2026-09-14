/**
 * Docker — server functions (WP-11).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic
 * is imported DYNAMICALLY inside each handler so import-protection never
 * sees `@/server/**` in the client bundle.
 *
 * Ported behavior:
 *   packages/dashboard/src/lib/server/docker/real-data.ts   (list fns + 3s cache)
 *   packages/dashboard/src/routes/api/docker/actions/+server.ts  (action dispatch)
 *
 * Server fns:
 *   listContainers   — GET  auth:any   → { items: Container[] }
 *   listImages       — GET  auth:any   → { items: DockerImage[] }  (dedup + no <none>)
 *   listVolumes      — GET  auth:any   → { items: DockerVolume[] }
 *   dockerAction     — POST auth:admin → { result }
 *                        destructive ops (stop/restart/rm/exec/privileged) require
 *                        an approval token passed through input.approvalToken;
 *                        the bridge verifies + consumes it internally.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ContainerListInput = z
  .object({
    filter: z.enum(["all", "running", "stopped", "paused", "restarting"]).optional(),
    query: z.string().max(128).optional(),
  })
  .strict();

const ImageListInput = z
  .object({
    query: z.string().max(128).optional(),
  })
  .strict();

const VolumeListInput = z
  .object({
    query: z.string().max(128).optional(),
  })
  .strict();

const DockerActionInput = z
  .object({
    op: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()).default({}),
    approvalToken: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// listContainers — GET, auth: any → { items: Container[] }
// ---------------------------------------------------------------------------

const listContainersGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ContainerListInput,
  surface: "docker",
  action: "docker.containers.list",
  handler: async ({ input }) => {
    const { listContainers } = await import("@/server/docker/real-data");
    const items = await listContainers({ filter: input.filter, query: input.query });
    return { items };
  },
});
export const listContainers = createServerFn({ method: "GET" })
  .middleware([listContainersGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// listImages — GET, auth: any → { items: DockerImage[] }
// Dedup + <none> filter is in the real-data layer.
// ---------------------------------------------------------------------------

const listImagesGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ImageListInput,
  surface: "docker",
  action: "docker.images.list",
  handler: async ({ input }) => {
    const { listImages } = await import("@/server/docker/real-data");
    const items = await listImages({ query: input.query });
    return { items };
  },
});
export const listImages = createServerFn({ method: "GET" })
  .middleware([listImagesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// listVolumes — GET, auth: any → { items: DockerVolume[] }
// ---------------------------------------------------------------------------

const listVolumesGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: VolumeListInput,
  surface: "docker",
  action: "docker.volumes.list",
  handler: async ({ input }) => {
    const { listVolumes } = await import("@/server/docker/real-data");
    const items = await listVolumes({ query: input.query });
    return { items };
  },
});
export const listVolumes = createServerFn({ method: "GET" })
  .middleware([listVolumesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// containerLogs — GET, auth: admin (MP-009, AN-004 §4).
// Returns the most-recent `limit` lines from `docker logs` (stdout+stderr
// merged inside the bridge). The id is a hex regex max 64 to match docker's
// container id shape and avoid shell-injection. `auth: "admin"` matches
// `dockerAction` gating because container logs can expose secrets
// (env vars, tokens) accidentally printed to stdout/stderr by apps.
// ---------------------------------------------------------------------------

const ContainerLogsInput = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9a-fA-F]+$/, "container id must be hex"),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const containerLogsGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: ContainerLogsInput,
  surface: "docker",
  action: "docker.container.logs",
  target: (input) => input.id,
  handler: async ({ input }) => {
    const { tailLogs } = await import("@/server/docker/real-data");
    const limit = input.limit ?? 100;
    const lines = await tailLogs(input.id, limit);
    return { id: input.id, limit, count: lines.length, lines };
  },
});
export const containerLogs = createServerFn({ method: "GET" })
  .middleware([containerLogsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// dockerAction — POST, auth: admin, rate-limit 10/min/user
//
// The bridge owns the approval-token verification + consumption (PB-5); we
// do NOT use defineServerFn's `approval: true` field. The token is passed
// through input.approvalToken so the bridge can bind it to the specific
// op+args hash. Destructive ops (stop/restart/rm/exec/privileged) require
// a token; read-only ops (logs/inspect/list) also require one per PB-5.
//
// If the bridge returns `rejected` with code `missing_approval`, the fn
// throws an `approval_required` error so the client can mint a token and
// retry with it.
// ---------------------------------------------------------------------------

const dockerActionGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: DockerActionInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "docker",
  action: "docker.action",
  target: (input) => input.op,
  handler: async ({ input, user, ctx }) => {
    const { allowlistedCommand } = await import("@/server/policy");
    const { dispatch } = await import("@/server/docker/bridge");
    const { validationError, approvalRequiredError, permissionError } =
      await import("@/server/errors/types");
    const { actionHashFor } = await import("@/server/approval");

    // Verify op is on the allowlist before touching the bridge.
    const entry = allowlistedCommand(input.op);
    if (!entry) {
      throw validationError(`Unsupported docker op: ${input.op}`, [
        { field: "op", message: "not in allowlist" },
      ]);
    }

    const sessionId = ctx.session?.id ?? null;
    // user is guaranteed non-null here: auth:'admin' gate rejects unauthenticated
    // requests before the handler is reached.
    const authedUser = user!;

    const result = await dispatch(
      {
        op: input.op,
        args: input.args,
        approvalToken: input.approvalToken ?? null,
        sessionId: sessionId ? String(sessionId) : null,
      },
      {
        user: authedUser,
        ip: ctx.clientIp ?? "unknown",
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      },
    );

    if (result.status === "rejected") {
      if (result.code === "missing_approval" || result.code === "invalid_approval") {
        // Surface the approval requirement so the client can mint a token.
        const actionHash = actionHashFor(input.op, {
          op: input.op,
          args: { ...input.args },
        });
        throw approvalRequiredError(actionHash, 60);
      }
      if (result.code === "arg_smuggling" || result.code === "argv_bash_c") {
        throw permissionError(result.reason);
      }
      throw validationError(result.reason, [
        ...(result.field ? [{ field: result.field, message: result.reason }] : []),
        { field: "op", message: result.code },
      ]);
    }

    return {
      result: {
        op: result.op,
        argv: result.argv,
        output: result.output,
        durationMs: result.durationMs,
      },
    };
  },
});
export const dockerAction = createServerFn({ method: "POST" })
  .middleware([dockerActionGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// dockerPruneEstimate — GET, auth: admin, rate-limit 30/60s/user (plan 0.5).
// Returns a TRUE dry-run reclaimable estimate from `docker system df` (parsed
// to bytes by the dedicated prune bridge). Read-only; never throws on the
// bridge side (returns zeros + `unavailable` flag instead).
// ---------------------------------------------------------------------------

const dockerPruneEstimateGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: z.object({}).strict(),
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "docker",
  action: "docker.prune.estimate",
  handler: async () => {
    const { estimateReclaimable } = await import("@/server/docker/prune");
    return estimateReclaimable();
  },
});
export const dockerPruneEstimate = createServerFn({ method: "GET" })
  .middleware([dockerPruneEstimateGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// dockerPrune — POST, auth: admin, rate-limit 5/60s/user, approval: true.
// Runs the SAFE prune (dangling images + build cache only) via the prune
// bridge; returns the reclaimed bytes. NEVER prunes volumes / `-a` / system.
// Gate options exported so the node-env pipeline test can drive the REAL
// handler with a fake executor.
// ---------------------------------------------------------------------------

interface DockerPruneOutput {
  reclaimedBytes: number;
  raw: string;
}

export const dockerPruneGateOptions: ServerFnOptions<Record<string, never>, DockerPruneOutput> = {
  method: "POST",
  auth: "admin",
  input: z.object({}).strict(),
  rateLimit: { limit: 5, windowSec: 60, bucket: "user" },
  surface: "docker",
  action: "docker.prune",
  approval: true,
  handler: async () => {
    const { runPrune } = await import("@/server/docker/prune");
    return runPrune();
  },
};
const dockerPruneGate = defineServerFn(dockerPruneGateOptions);
export const dockerPrune = createServerFn({ method: "POST" })
  .middleware([dockerPruneGate])
  .handler(serverFnNoop);
