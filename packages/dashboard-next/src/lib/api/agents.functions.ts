/**
 * Agents (Hermes profiles) — server functions (WP-21).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/audit + the business handler. All server-only logic is imported
 * DYNAMICALLY inside each handler so import-protection never sees `@/server/**`
 * in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/(authed)/agents/+page.server.ts  (list scan)
 *   packages/dashboard/src/routes/api/agents/[slug]/files/+server.ts (file ops)
 *
 * Registry source: HERMES_PROFILES_REGISTRY, defaulting to hermes/profiles.json
 * under the configured data root. Profile homes come from that registry.
 *
 * Frontend (Wave 2) calls these typed:
 *   await listAgents({ data: {} })
 *   await uploadAgentFile({ data: { slug, filename, content } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { slugSchema } from "@/lib/api/schemas";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const AgentListInput = z.object({}).strict();

const UploadAgentFileInput = z
  .object({
    /** Profile slug — must match a registry entry. */
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9_-]+$/, "slug must be lowercase letters, numbers, underscores and hyphens"),
    /** Destination filename within the profile directory (no path separators, no `..`). */
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine((f) => !f.includes("..") && !f.startsWith("/"), {
        message: "filename must not contain '..' or start with '/'",
      }),
    /** UTF-8 file content (≤ 10 MB). Clients that need binary should base64-encode. */
    content: z.string().max(10 * 1024 * 1024),
  })
  .strict();

const AgentStatusesInput = z
  .object({
    /** Restrict to these slugs; omit to query every registry profile. */
    slugs: z.array(z.string()).optional(),
  })
  .strict();

const ReadAgentFilesInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9_-]+$/, "slug must be lowercase letters, numbers, underscores and hyphens"),
  })
  .strict();

const AgentActionInput = z
  .object({
    /** Profile slug — must match a registry entry. */
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9_-]+$/, "slug must be lowercase letters, numbers, underscores and hyphens"),
    /** Control verb acting on the agent's gateway + profile units. */
    action: z.enum(["start", "stop", "restart", "pause"]),
  })
  .strict();

type AgentActionInputT = z.infer<typeof AgentActionInput>;

// ---------------------------------------------------------------------------
// listAgents — GET, auth: any → { agents: HermesProfile[] }
// ---------------------------------------------------------------------------

const listAgentsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: AgentListInput,
  surface: "agents",
  action: "agents.list",
  handler: async () => {
    const { readRegistry } = await import("@/server/agents/registry");
    const agents = readRegistry();
    return { agents };
  },
});
export const listAgents = createServerFn({ method: "GET" })
  .middleware([listAgentsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// uploadAgentFile — POST, auth: admin → { ok: true, filename } | 400/404
// Path-traversal safe: scoped to the profile's home directory.
// ---------------------------------------------------------------------------

const uploadAgentFileGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: UploadAgentFileInput,
  surface: "agents",
  action: "agents.file.upload",
  target: (input) => `${input.slug}:${input.filename}`,
  handler: async ({ input }) => {
    const { findProfileBySlug } = await import("@/server/agents/registry");
    const { writeAgentFile } = await import("@/server/agents/files");
    const { notFoundError, validationError } = await import("@/server/errors/types");

    const profile = findProfileBySlug(input.slug);
    if (!profile) throw notFoundError(`Agent profile '${input.slug}' not found`, "agent");

    try {
      writeAgentFile(profile.home, input.filename, Buffer.from(input.content, "utf8"));
    } catch (err) {
      if (err instanceof Error && err.message === "path_traversal") {
        throw validationError("path traversal blocked", [
          { field: "filename", message: "path traversal blocked" },
        ]);
      }
      throw err;
    }

    return { ok: true as const, filename: input.filename };
  },
});
export const uploadAgentFile = createServerFn({ method: "POST" })
  .middleware([uploadAgentFileGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// readAgentFiles — GET, auth: admin → { files: AgentFile[] }
// Recursively reads the human-readable config files under the profile's home
// for the Inspect dialog. Server-side filters skip cache/log/binary files AND
// credential dirs/files (mcp-tokens, *token*, channel_directory, .env, …) and
// redact credential-shaped substrings defensively. Admin-only.
// ---------------------------------------------------------------------------

const readAgentFilesGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: ReadAgentFilesInput,
  surface: "agents",
  action: "agents.files.read",
  handler: async ({ input }) => {
    const { findProfileBySlug } = await import("@/server/agents/registry");
    const { readAgentFiles } = await import("@/server/agents/files");
    const { notFoundError } = await import("@/server/errors/types");
    const profile = findProfileBySlug(input.slug);
    if (!profile) throw notFoundError(`Agent profile '${input.slug}' not found`, "agent");
    return { files: readAgentFiles(profile.home) };
  },
});
export const readAgentFiles = createServerFn({ method: "GET" })
  .middleware([readAgentFilesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// agentStatuses — GET, auth: any → { states: Record<slug, runtime-state> }
// Derives each agent's live run-state from `systemctl is-active` on its two
// template units (gateway + profile). No input → every registry slug.
// ---------------------------------------------------------------------------

const agentStatusesGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: AgentStatusesInput,
  surface: "agents",
  action: "agents.status",
  handler: async ({ input }) => {
    const { getAgentRuntimes } = await import("@/server/agents/control");
    const { readRegistry } = await import("@/server/agents/registry");
    const slugs =
      input.slugs && input.slugs.length > 0 ? input.slugs : readRegistry().map((p) => p.profile);
    const states = await getAgentRuntimes(slugs);
    return { states };
  },
});
export const agentStatuses = createServerFn({ method: "GET" })
  .middleware([agentStatusesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// agentAction — POST, auth: admin, rate-limit 10/min/user, approval: true.
// Dispatch start/stop/restart/pause to the agent's systemd units via the
// agent-control bridge. The pipeline's `approval: true` gate consumes the
// caller's minted token (the UI mints via callMintApproval); there is NO
// internal bridge gate to self-mint past — unlike the systemd handler.
// ---------------------------------------------------------------------------

interface AgentActionOutput {
  slug: string;
  action: "start" | "stop" | "restart" | "pause";
  status: "accepted" | "rejected";
  units: { unit: string; exitCode: number; stderr: string }[];
  state: "running" | "idle" | "stopped" | "error";
}

/**
 * agentAction gate options. Exported so the node-env test can drive the REAL
 * handler (and the real control bridge with a fake executor) through the
 * `defineApiRoute` pipeline — a single source of truth for the gate + handler.
 */
export const agentActionGateOptions: ServerFnOptions<AgentActionInputT, AgentActionOutput> = {
  method: "POST",
  auth: "admin",
  input: AgentActionInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "agents",
  action: "agents.action",
  target: (input) => `${input.action}:${input.slug}`,
  approval: true,
  handler: async ({ input, user, ctx }) => {
    const { controlAgent, UnknownAgentError } = await import("@/server/agents/control");
    const { validationError, notFoundError } = await import("@/server/errors/types");

    let result;
    try {
      result = await controlAgent(input.slug, input.action, {
        userId: user ? String(user.id) : null,
        sessionId: ctx.session?.id ? String(ctx.session.id) : null,
        ip: ctx.clientIp,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        throw notFoundError(err.message, "agent");
      }
      throw err;
    }

    if (result.status === "rejected") {
      throw validationError(result.reason ?? "agent control rejected", [
        { field: "action", message: result.reason ?? "systemctl failed" },
      ]);
    }

    return {
      slug: result.slug,
      action: result.action,
      status: result.status,
      units: result.units,
      state: result.state,
    };
  },
};
const agentActionGate = defineServerFn(agentActionGateOptions);
export const agentAction = createServerFn({ method: "POST" })
  .middleware([agentActionGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// agentChat — POST, auth: admin, rate-limit 30/min/user.
// Sends a text turn (+ optional media / model override) to a profile's local
// HTTP API via the chat bridge. Request/response (no streaming — P3).
// ---------------------------------------------------------------------------

const AgentChatInput = z
  .object({
    slug: slugSchema(),
    text: z.string().max(32000),
    attachments: z
      .array(
        z.object({
          filename: z.string().max(255),
          mime: z.string().max(128),
          dataBase64: z.string().max(35_000_000),
        }),
      )
      .max(8)
      .optional(),
    model: z.string().max(128).optional(),
    reasoning: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

type AgentChatInputT = z.infer<typeof AgentChatInput>;

interface AgentChatOutput {
  slug: string;
  reply: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

/**
 * agentChat gate options. Exported so the node-env test can drive the REAL
 * handler through the defineApiRoute pipeline. Auth: admin (chat can trigger
 * host-side tmp writes via attachments).
 */
export const agentChatGateOptions: ServerFnOptions<AgentChatInputT, AgentChatOutput> = {
  method: "POST",
  auth: "admin",
  input: AgentChatInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "agents",
  action: "agents.chat",
  target: (input) => input.slug,
  handler: async ({ input }) => {
    const { chatWithAgent } = await import("@/server/agents/chat");
    const { notFoundError, isApiError } = await import("@/server/errors/types");

    try {
      const { reply, usage, latencyMs } = await chatWithAgent(input.slug, {
        text: input.text,
        attachments: input.attachments,
        model: input.model,
        reasoning: input.reasoning,
      });
      return { slug: input.slug, reply, usage, latencyMs };
    } catch (err) {
      if (isApiError(err) && err.kind === "not_found") {
        throw notFoundError(err.message, "agent");
      }
      throw err;
    }
  },
};
const agentChatGate = defineServerFn(agentChatGateOptions);
export const agentChat = createServerFn({ method: "POST" })
  .middleware([agentChatGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// setAgentModel — POST, auth: admin, approval: true.
// Validates + persists a model/reasoning swap for a profile, then restarts its
// units. Approval gate consumes the caller-minted token; the pipeline hashes
// `action + full input`, so the UI must mint `agents.model` with the COMPLETE
// payload `{ slug, model, reasoning }` (not just slug+model).
// ---------------------------------------------------------------------------

const SetAgentModelInput = z
  .object({
    slug: slugSchema(),
    model: z.string().min(1).max(128),
    reasoning: z.enum(["low", "medium", "high"]),
  })
  .strict();

type SetAgentModelInputT = z.infer<typeof SetAgentModelInput>;

interface SetAgentModelOutput {
  slug: string;
  model: string;
  reasoning: "low" | "medium" | "high";
  restarted: { unit: string; exitCode: number }[];
}

export const setAgentModelGateOptions: ServerFnOptions<SetAgentModelInputT, SetAgentModelOutput> = {
  method: "POST",
  auth: "admin",
  input: SetAgentModelInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "agents",
  action: "agents.model",
  target: (input) => `${input.slug}:${input.model}`,
  approval: true,
  handler: async ({ input, user, ctx }) => {
    const { setAgentModel, UnknownAgentError } = await import("@/server/agents/control");
    const { notFoundError } = await import("@/server/errors/types");

    try {
      return await setAgentModel(
        input.slug,
        { model: input.model, reasoning: input.reasoning },
        {
          userId: user ? String(user.id) : null,
          sessionId: ctx.session?.id ? String(ctx.session.id) : null,
          ip: ctx.clientIp,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        },
      );
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        throw notFoundError(err.message, "agent");
      }
      throw err;
    }
  },
};
const setAgentModelGate = defineServerFn(setAgentModelGateOptions);
export const setAgentModel = createServerFn({ method: "POST" })
  .middleware([setAgentModelGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
