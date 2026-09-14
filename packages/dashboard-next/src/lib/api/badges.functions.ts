/**
 * Badges — server functions.
 *
 * Transport is createServerFn RPC (ADR-001). Each fn is a top-level
 * `createServerFn(...).middleware([gate]).handler(serverFnNoop)`; the gate
 * (`defineServerFn`) carries auth/RBAC/CSRF/rate-limit/audit + the handler.
 * Server-only logic (db repo) is imported DYNAMICALLY inside each handler.
 *
 * Reads are `auth: any`; writes are `auth: admin`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

const HEX = /^#[0-9a-fA-F]{6}$/;

const BadgeIdInput = z.object({ id: z.coerce.number().int().positive() }).strict();

const BadgeCreateInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens"),
    label: z.string().min(1).max(64),
    color: z.string().regex(HEX, "color must be a #RRGGBB hex value").default("#1f2937"),
    textColor: z.string().regex(HEX, "textColor must be a #RRGGBB hex value").default("#ffffff"),
  })
  .strict();

const BadgePatchInput = z
  .object({
    id: z.coerce.number().int().positive(),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    label: z.string().min(1).max(64).optional(),
    color: z.string().regex(HEX).optional(),
    textColor: z.string().regex(HEX).optional(),
  })
  .strict();

type BadgeCreateInputT = z.infer<typeof BadgeCreateInput>;
type BadgePatchInputT = z.infer<typeof BadgePatchInput>;
type BadgeIdInputT = z.infer<typeof BadgeIdInput>;

/** Badge row shape returned by the create/patch handlers (mirrors the DB row). */
interface BadgeRow {
  id: number;
  slug: string;
  label: string;
  color: string;
  textColor: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// listBadges — GET, auth: any → { rows }
// ---------------------------------------------------------------------------

const listGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  surface: "badges",
  action: "badges.list",
  handler: async () => {
    const { getDb } = await import("@/server/db/client");
    const { listBadges: repoList } = await import("@/server/db/repos/badges");
    const rows = await repoList(getDb());
    return { rows };
  },
});
export const listBadges = createServerFn({ method: "GET" })
  .middleware([listGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// createBadge — POST, auth: admin → Badge
// ---------------------------------------------------------------------------

export const badgesCreateGateOptions: ServerFnOptions<BadgeCreateInputT, BadgeRow> = {
  method: "POST",
  auth: "admin",
  input: BadgeCreateInput,
  surface: "badges",
  action: "badges.create",
  target: (input) => input.slug,
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { createBadge: repoCreate, getBadgeBySlug } = await import("@/server/db/repos/badges");
    const { validationError } = await import("@/server/errors/types");
    const db = getDb();
    if (await getBadgeBySlug(db, input.slug)) {
      throw validationError(`A badge with slug '${input.slug}' already exists`, []);
    }
    return repoCreate(db, {
      slug: input.slug,
      label: input.label,
      color: input.color,
      textColor: input.textColor,
    });
  },
};
const createGate = defineServerFn(badgesCreateGateOptions);
export const createBadge = createServerFn({ method: "POST" })
  .middleware([createGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// patchBadge — POST, auth: admin → Badge | 404
// ---------------------------------------------------------------------------

export const badgesPatchGateOptions: ServerFnOptions<BadgePatchInputT, BadgeRow> = {
  method: "POST",
  auth: "admin",
  input: BadgePatchInput,
  surface: "badges",
  action: "badges.update",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { updateBadge } = await import("@/server/db/repos/badges");
    const { notFoundError } = await import("@/server/errors/types");
    const { id, ...patch } = input;
    const next = await updateBadge(getDb(), id, patch);
    if (!next) throw notFoundError(`Badge ${id} not found`, "badge");
    return next;
  },
};
const patchGate = defineServerFn(badgesPatchGateOptions);
export const patchBadge = createServerFn({ method: "POST" })
  .middleware([patchGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// deleteBadge — POST, auth: admin → { ok: true } | 404
// ---------------------------------------------------------------------------

export const badgesDeleteGateOptions: ServerFnOptions<BadgeIdInputT, { ok: true }> = {
  method: "POST",
  auth: "admin",
  input: BadgeIdInput,
  surface: "badges",
  action: "badges.delete",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { deleteBadge: repoDelete } = await import("@/server/db/repos/badges");
    const { notFoundError } = await import("@/server/errors/types");
    const ok = await repoDelete(getDb(), input.id);
    if (!ok) throw notFoundError(`Badge ${input.id} not found`, "badge");
    return { ok: true } as const;
  },
};
const deleteGate = defineServerFn(badgesDeleteGateOptions);
export const deleteBadge = createServerFn({ method: "POST" })
  .middleware([deleteGate])
  .handler(serverFnNoop);
