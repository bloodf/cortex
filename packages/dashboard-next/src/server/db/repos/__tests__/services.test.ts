// @vitest-environment node
/**
 * Services repository tests.
 *
 * Covers: list (with pagination, filter, sort, search), get by id/slug,
 * category list, create, partial update, delete.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import { badges, serviceBadges } from "../../schema";
import {
  listServices,
  getServiceById,
  getServiceBySlug,
  listCategories,
  createService,
  updateService,
  deleteService,
} from "../services";

let db: PgliteDbClient;
let client: PGlite;

beforeEach(async () => {
  const r = await createTestDb();
  db = r.db;
  client = r.client;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("services repo", () => {
  it("listServices returns the seeded catalog", async () => {
    const result = await listServices(db, { activeOnly: true });
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.rows.find((s) => s.slug === "postgresql")).toBeDefined();
  });

  it("listServices filters by hasWebui=true (also requires showInWebui=true)", async () => {
    await createService(db, {
      slug: "no-webui-svc",
      name: "No Web UI",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 99,
      isActive: true,
      hasWebui: false,
      showInHealthcheck: false,
      showInWebui: false,
    });
    // has_webui=true but show_in_webui=false → must NOT appear in /apps
    await createService(db, {
      slug: "hidden-webui-svc",
      name: "Hidden Web UI",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 98,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: false,
      showInWebui: false,
    });
    const result = await listServices(db, { hasWebui: true, activeOnly: false });
    expect(result.rows.every((s) => s.hasWebui === true)).toBe(true);
    expect(result.rows.every((s) => s.showInWebui === true)).toBe(true);
    expect(result.rows.find((s) => s.slug === "no-webui-svc")).toBeUndefined();
    expect(result.rows.find((s) => s.slug === "hidden-webui-svc")).toBeUndefined();
    expect(result.rows.find((s) => s.slug === "grafana")).toBeDefined();
  });

  it("listServices excludes inactive services by default", async () => {
    await createService(db, {
      slug: "hidden",
      name: "Hidden",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 99,
      isActive: false,
      hasWebui: false,
      showInHealthcheck: false,
      showInWebui: false,
    });
    const active = await listServices(db, { activeOnly: true });
    const all = await listServices(db, { activeOnly: false });
    expect(active.rows.find((s) => s.slug === "hidden")).toBeUndefined();
    expect(all.rows.find((s) => s.slug === "hidden")).toBeDefined();
  });

  it("listServices paginates", async () => {
    const page1 = await listServices(db, { page: 1, pageSize: 1 });
    const page2 = await listServices(db, { page: 2, pageSize: 1 });
    expect(page1.rows.length).toBe(1);
    expect(page2.rows.length).toBe(1);
    expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
  });

  it("listServices filters by category", async () => {
    const result = await listServices(db, { category: "Database" });
    expect(result.rows.every((s) => s.category === "Database")).toBe(true);
  });

  it("listServices searches by name", async () => {
    const result = await listServices(db, { search: "grafana" });
    expect(result.rows.find((s) => s.slug === "grafana")).toBeDefined();
  });

  it("listServices sorts by name desc", async () => {
    const result = await listServices(db, { sortBy: "name", sortDir: "desc" });
    const names = result.rows.map((s) => s.name);
    const sorted = [...names].sort().reverse();
    expect(names).toEqual(sorted);
  });

  it("getServiceById returns the row", async () => {
    const result = await listServices(db, { activeOnly: true, pageSize: 1 });
    const first = result.rows[0];
    const got = await getServiceById(db, first.id);
    expect(got?.id).toBe(first.id);
  });

  it("getServiceBySlug returns the row", async () => {
    const got = await getServiceBySlug(db, "postgresql");
    expect(got?.name).toBe("PostgreSQL");
  });

  it("listCategories returns distinct categories", async () => {
    const cats = await listCategories(db);
    expect(cats).toContain("Database");
    expect(cats).toContain("Monitoring");
  });

  it("createService inserts and returns the row", async () => {
    const s = await createService(db, {
      slug: "test-svc",
      name: "Test",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });
    expect(s.slug).toBe("test-svc");
  });

  it("updateService updates only the specified fields", async () => {
    const created = await createService(db, {
      slug: "upd-svc",
      name: "Upd",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });
    const updated = await updateService(db, created.id, { name: "Upd2" });
    expect(updated?.name).toBe("Upd2");
    expect(updated?.slug).toBe("upd-svc"); // unchanged
  });

  it("updateService ignores unknown fields", async () => {
    const created = await createService(db, {
      slug: "ignore-svc",
      name: "Ignore",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });
    const updated = await updateService(db, created.id, { notAColumn: "x" } as never);
    expect(updated?.name).toBe("Ignore");
  });

  it("deleteService removes the row", async () => {
    const created = await createService(db, {
      slug: "del-svc",
      name: "Del",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "auto",
      iconColor: null,
      iconImage: null,
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });
    expect(await deleteService(db, created.id)).toBe(true);
    expect(await getServiceById(db, created.id)).toBeNull();
  });
});

/**
 * Contract-shape round-trip (MP-028 / item 1.1, "hashId class" data drop).
 *
 * The read functions must fold the flat `icon_*` columns into a nested `icon`
 * object and aggregate the `service_badges → badges` join into a `badges`
 * array — otherwise the client adapter (`toServiceRow`) silently drops every
 * icon + badge because the raw Drizzle row has neither `.icon` nor `.badges`.
 *
 * These tests feed REAL DB-shaped rows: integer serial ids, NULL icon fields,
 * and real join rows (NOT uuid strings).
 */
describe("services repo — contract shape (icon + badges)", () => {
  /** Create two badge rows and assign them to `serviceId`. */
  async function seedBadges(serviceId: number): Promise<void> {
    const inserted = await db
      .insert(badges)
      .values([
        { slug: "beta", label: "Beta", color: "#10b981", textColor: "#ffffff" },
        { slug: "internal", label: "Internal", color: "#6366f1", textColor: "#ffffff" },
      ])
      .returning({ id: badges.id });
    await db.insert(serviceBadges).values(inserted.map((b) => ({ serviceId, badgeId: b.id })));
  }

  it("getServiceById returns nested icon + aggregated badges", async () => {
    const created = await createService(db, {
      slug: "badged-svc",
      name: "Badged",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "monogram",
      iconColor: "#abcdef",
      iconImage: "/uploads/x.png",
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });
    await seedBadges(created.id);

    const got = await getServiceById(db, created.id);
    expect(got).not.toBeNull();
    expect(got?.icon).toEqual({ type: "monogram", color: "#abcdef", image: "/uploads/x.png" });
    expect(got?.badges).toHaveLength(2);
    expect(got?.badges.map((b) => b.slug).sort()).toEqual(["beta", "internal"]);
    const beta = got?.badges.find((b) => b.slug === "beta");
    expect(beta).toEqual({ slug: "beta", label: "Beta", color: "#10b981" });
    // The flat icon_* columns must NOT leak onto the contract row.
    expect("iconType" in (got as object)).toBe(false);
    expect("iconColor" in (got as object)).toBe(false);
    expect("iconImage" in (got as object)).toBe(false);
  });

  it("listServices populates icon + badges per row without N+1 drift", async () => {
    const created = await createService(db, {
      slug: "list-badged",
      name: "ListBadged",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: "monogram",
      iconColor: "#123456",
      iconImage: null,
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });
    await seedBadges(created.id);

    const result = await listServices(db, { activeOnly: false, pageSize: 500 });
    const row = result.rows.find((s) => s.slug === "list-badged");
    expect(row).toBeDefined();
    expect(row?.icon).toEqual({ type: "monogram", color: "#123456", image: null });
    expect(row?.badges).toHaveLength(2);
    // A service with NO badges yields an empty array (never undefined).
    const seeded = result.rows.find((s) => s.slug === "postgresql");
    expect(seeded?.badges).toEqual([]);
  });

  it("NULL icon fields default to icon.type 'auto' without throwing", async () => {
    // Insert a row with NULL iconType/iconColor/iconImage straight through
    // the raw column path (the column default is applied only on omission, so
    // explicit nulls exercise the repo's `?? 'auto'` guard).
    const created = await createService(db, {
      slug: "null-icon",
      name: "NullIcon",
      kind: "service",
      category: "Test",
      healthUrl: "#",
      healthType: "http",
      openUrl: "#",
      iconType: null,
      iconColor: null,
      iconImage: null,
      sortOrder: 0,
      isActive: true,
      hasWebui: true,
      showInHealthcheck: true,
      showInWebui: true,
    });

    const bySlug = await getServiceBySlug(db, "null-icon");
    expect(bySlug?.icon).toEqual({ type: "auto", color: null, image: null });
    expect(bySlug?.badges).toEqual([]);

    const byId = await getServiceById(db, created.id);
    expect(byId?.icon.type).toBe("auto");
  });
});
