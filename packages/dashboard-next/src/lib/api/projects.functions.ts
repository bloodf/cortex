/**
 * Projects — server functions.
 *
 * Transport is createServerFn RPC (ADR-001). Reads are `auth: any`; writes are
 * `auth: admin`. Server-only logic (db repo) is imported DYNAMICALLY inside
 * each handler so the client bundle never sees `@/server/**`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

const ProjectIdInput = z.object({ id: z.coerce.number().int().positive() }).strict();

const ProjectCreateInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens"),
    name: z.string().min(1).max(255),
    repoUrl: z.string().url().max(512).optional().nullable(),
    primaryPmAccount: z.string().max(128).optional().nullable(),
    messagingMode: z.enum(["single", "distributed"]).default("single"),
  })
  .strict();

const ProjectPatchInput = z
  .object({
    id: z.coerce.number().int().positive(),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    name: z.string().min(1).max(255).optional(),
    repoUrl: z.string().url().max(512).nullable().optional(),
    primaryPmAccount: z.string().max(128).nullable().optional(),
    messagingMode: z.enum(["single", "distributed"]).optional(),
  })
  .strict();

type ProjectCreateInputT = z.infer<typeof ProjectCreateInput>;
type ProjectPatchInputT = z.infer<typeof ProjectPatchInput>;
type ProjectIdInputT = z.infer<typeof ProjectIdInput>;

/** Project row shape returned by the create/patch handlers (mirrors the DB row). */
interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  repoUrl: string | null;
  primaryPmAccount: string | null;
  messagingMode: string;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// listProjects — GET, auth: any → { rows }
// ---------------------------------------------------------------------------

const listGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  surface: "projects",
  action: "projects.list",
  handler: async () => {
    const { getDb } = await import("@/server/db/client");
    const { listProjects: repoList } = await import("@/server/db/repos/projects");
    const rows = await repoList(getDb());
    return { rows };
  },
});
export const listProjects = createServerFn({ method: "GET" })
  .middleware([listGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// createProject — POST, auth: admin → Project
// ---------------------------------------------------------------------------

export const projectsCreateGateOptions: ServerFnOptions<ProjectCreateInputT, ProjectRow> = {
  method: "POST",
  auth: "admin",
  input: ProjectCreateInput,
  surface: "projects",
  action: "projects.create",
  target: (input) => input.slug,
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { createProject: repoCreate, getProjectBySlug } =
      await import("@/server/db/repos/projects");
    const { validationError } = await import("@/server/errors/types");
    const db = getDb();
    if (await getProjectBySlug(db, input.slug)) {
      throw validationError(`A project with slug '${input.slug}' already exists`, []);
    }
    return repoCreate(db, {
      slug: input.slug,
      name: input.name,
      repoUrl: input.repoUrl ?? null,
      primaryPmAccount: input.primaryPmAccount ?? null,
      messagingMode: input.messagingMode,
    });
  },
};
const createGate = defineServerFn(projectsCreateGateOptions);
export const createProject = createServerFn({ method: "POST" })
  .middleware([createGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// patchProject — POST, auth: admin → Project | 404
// ---------------------------------------------------------------------------

export const projectsPatchGateOptions: ServerFnOptions<ProjectPatchInputT, ProjectRow> = {
  method: "POST",
  auth: "admin",
  input: ProjectPatchInput,
  surface: "projects",
  action: "projects.update",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { updateProject } = await import("@/server/db/repos/projects");
    const { notFoundError } = await import("@/server/errors/types");
    const { id, ...patch } = input;
    const next = await updateProject(getDb(), id, patch);
    if (!next) throw notFoundError(`Project ${id} not found`, "project");
    return next;
  },
};
const patchGate = defineServerFn(projectsPatchGateOptions);
export const patchProject = createServerFn({ method: "POST" })
  .middleware([patchGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// deleteProject — POST, auth: admin → { ok: true } | 404
// ---------------------------------------------------------------------------

export const projectsDeleteGateOptions: ServerFnOptions<ProjectIdInputT, { ok: true }> = {
  method: "POST",
  auth: "admin",
  input: ProjectIdInput,
  surface: "projects",
  action: "projects.delete",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { deleteProject: repoDelete } = await import("@/server/db/repos/projects");
    const { notFoundError } = await import("@/server/errors/types");
    const ok = await repoDelete(getDb(), input.id);
    if (!ok) throw notFoundError(`Project ${input.id} not found`, "project");
    return { ok: true } as const;
  },
};
const deleteGate = defineServerFn(projectsDeleteGateOptions);
export const deleteProject = createServerFn({ method: "POST" })
  .middleware([deleteGate])
  .handler(serverFnNoop);
