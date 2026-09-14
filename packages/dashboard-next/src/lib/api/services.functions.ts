/**
 * Services & health — server functions (WP-10).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic
 * (db repos, schema, the health probe) is imported DYNAMICALLY inside each
 * handler so import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/services/+server.ts          (list/create)
 *   packages/dashboard/src/routes/api/services/[id]/+server.ts     (read/patch/delete)
 *   packages/dashboard/src/routes/api/services/[id]/health/+server.ts (health)
 *
 * Frontend (Wave 2) calls these typed:
 *   await listServices({ data: { category } })
 *   await createService({ data: { slug, name, ... } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas (mirror the legacy zod validation exactly)
// ---------------------------------------------------------------------------

const ServiceListInput = z
  .object({
    category: z.string().min(1).max(64).optional(),
    kind: z.enum(["app", "service", "docker", "process", "dashboard-launcher"]).optional(),
    status: z.string().min(1).max(16).optional(),
    activeOnly: z.coerce.boolean().optional(),
    hasWebui: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const ServiceIdInput = z.object({ id: z.coerce.number().int().positive() }).strict();

const ServiceCreateInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens"),
    name: z.string().min(1).max(128),
    description: z.string().max(2000).optional().nullable(),
    healthUrl: z.string().url().optional().nullable(),
    healthType: z.enum(["http", "tcp", "docker", "systemd", "process"]).default("http"),
    category: z.string().min(1).max(64),
    openUrl: z.string().url().optional().nullable(),
    kind: z.enum(["app", "service", "docker", "process", "dashboard-launcher"]).default("service"),
  })
  .strict();

const ServicePatchInput = z
  .object({
    id: z.coerce.number().int().positive(),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(2000).nullable().optional(),
    healthUrl: z.string().url().nullable().optional(),
    healthType: z.enum(["http", "tcp", "docker", "systemd", "process"]).optional(),
    category: z.string().min(1).max(64).optional(),
    openUrl: z.string().url().nullable().optional(),
    kind: z.enum(["app", "service", "docker", "process", "dashboard-launcher"]).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    showInHealthcheck: z.boolean().optional(),
    showInWebui: z.boolean().optional(),
  })
  .strict();

const ServiceHealthListInput = z
  .object({
    id: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const ServiceHealthRecheckInput = z
  .object({
    id: z.coerce.number().int().positive(),
    source: z.enum(["auto", "manual", "scheduled"]).default("manual"),
  })
  .strict();

// ---------------------------------------------------------------------------
// listServices — GET, auth: any → { rows, total }
// ---------------------------------------------------------------------------

const listGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ServiceListInput,
  surface: "services",
  action: "services.list",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { listServices: repoList } = await import("@/server/db/repos/services");
    const { rows, total } = await repoList(getDb(), {
      category: input.category,
      kind: input.kind,
      status: input.status,
      activeOnly: input.activeOnly ?? false,
      hasWebui: input.hasWebui,
      page: input.page,
      pageSize: input.pageSize,
    });
    return { rows, total };
  },
});
export const listServices = createServerFn({ method: "GET" })
  .middleware([listGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getService — GET, auth: any → Service | 404
// ---------------------------------------------------------------------------

const getGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ServiceIdInput,
  surface: "services",
  action: "services.read",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { getServiceById } = await import("@/server/db/repos/services");
    const { notFoundError } = await import("@/server/errors/types");
    const svc = await getServiceById(getDb(), input.id);
    if (!svc) throw notFoundError(`Service ${input.id} not found`, "service");
    return svc;
  },
});
export const getService = createServerFn({ method: "GET" })
  .middleware([getGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// createService — POST, auth: admin → Service (201)
// ---------------------------------------------------------------------------

const createGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ServiceCreateInput,
  surface: "services",
  action: "services.create",
  target: (input) => input.slug,
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { createService: repoCreate } = await import("@/server/db/repos/services");
    return repoCreate(getDb(), {
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      healthUrl: input.healthUrl ?? undefined,
      healthType: input.healthType,
      category: input.category,
      openUrl: input.openUrl ?? undefined,
      kind: input.kind,
    });
  },
});
export const createService = createServerFn({ method: "POST" })
  .middleware([createGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// patchService — POST, auth: admin → Service | 404
// ---------------------------------------------------------------------------

const patchGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ServicePatchInput,
  surface: "services",
  action: "services.update",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { updateService } = await import("@/server/db/repos/services");
    const { notFoundError } = await import("@/server/errors/types");
    const { id, healthUrl, openUrl, ...rest } = input;
    // `health_url` / `open_url` are NOT NULL columns (DB default `#`); a
    // null patch value is invalid, so a null clears to undefined (skip).
    const patch = {
      ...rest,
      ...(healthUrl != null ? { healthUrl } : {}),
      ...(openUrl != null ? { openUrl } : {}),
    };
    const next = await updateService(getDb(), id, patch);
    if (!next) throw notFoundError(`Service ${id} not found`, "service");
    return next;
  },
});
export const patchService = createServerFn({ method: "POST" })
  .middleware([patchGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// deleteService — POST, auth: admin → { ok: true } | 404
// ---------------------------------------------------------------------------

const deleteGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ServiceIdInput,
  surface: "services",
  action: "services.delete",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { deleteService: repoDelete } = await import("@/server/db/repos/services");
    const { notFoundError } = await import("@/server/errors/types");
    const ok = await repoDelete(getDb(), input.id);
    if (!ok) throw notFoundError(`Service ${input.id} not found`, "service");
    return { ok: true } as const;
  },
});
export const deleteService = createServerFn({ method: "POST" })
  .middleware([deleteGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// listServiceHealth — GET, auth: any → { snapshots } (newest-first)
// ---------------------------------------------------------------------------

const healthListGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ServiceHealthListInput,
  surface: "services",
  action: "services.health.list",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { desc, eq } = await import("drizzle-orm");
    const { getDb } = await import("@/server/db/client");
    const { getServiceById } = await import("@/server/db/repos/services");
    const { serviceHealthLog } = await import("@/server/db/schema");
    const { notFoundError } = await import("@/server/errors/types");

    const db = getDb();
    const svc = await getServiceById(db, input.id);
    if (!svc) throw notFoundError(`Service ${input.id} not found`, "service");

    const limit = input.limit ?? 100;
    const logs = await db
      .select()
      .from(serviceHealthLog)
      .where(eq(serviceHealthLog.serviceId, input.id))
      .orderBy(desc(serviceHealthLog.checkedAt))
      .limit(limit);

    const snapshots = logs.map((log) => ({
      id: `shs_${log.id}`,
      serviceId: log.serviceId,
      status: log.status,
      latencyMs: log.responseTimeMs ?? null,
      checkedAt:
        log.checkedAt instanceof Date ? log.checkedAt.toISOString() : String(log.checkedAt),
      note: null as string | null,
    }));
    return { snapshots };
  },
});
export const listServiceHealth = createServerFn({ method: "GET" })
  .middleware([healthListGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// recheckServiceHealth — POST, auth: admin, rate-limit 10/min/user → { snapshot }
// Reuses the scheduler's probe logic (same probe per health_type).
// ---------------------------------------------------------------------------

const healthRecheckGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ServiceHealthRecheckInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "services",
  action: "services.health.recheck",
  target: (input) => String(input.id),
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { getServiceById, updateService } = await import("@/server/db/repos/services");
    const { serviceHealthLog } = await import("@/server/db/schema");
    const { notFoundError, systemError } = await import("@/server/errors/types");
    const { probe } = await import("@/server/health");

    const db = getDb();
    const svc = await getServiceById(db, input.id);
    if (!svc) throw notFoundError(`Service ${input.id} not found`, "service");

    const result = await probe({
      id: svc.id,
      slug: svc.slug,
      healthType: svc.healthType,
      healthUrl: svc.healthUrl,
    });

    const checkedAt = new Date();
    const updated = await updateService(db, svc.id, {
      status: result.status,
      responseMs: result.responseMs,
      lastCheckAt: checkedAt,
    });
    if (!updated) throw systemError("Failed to persist health probe result");
    try {
      await db.insert(serviceHealthLog).values({
        serviceId: svc.id,
        status: result.status,
        responseTimeMs: result.responseMs ?? null,
        checkedAt,
      });
    } catch {
      // snapshot logging is best-effort; the catalog row is the source of truth.
    }

    return {
      snapshot: {
        serviceId: svc.id,
        status: result.status,
        responseMs: result.responseMs,
        checkedAt: checkedAt.toISOString(),
        source: input.source,
      },
    };
  },
});
export const recheckServiceHealth = createServerFn({ method: "POST" })
  .middleware([healthRecheckGate])
  .handler(serverFnNoop);
