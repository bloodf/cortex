/**
 * Badge catalog repository.
 *
 * Badges are small labelled chips attached to services (see `service_badges`).
 * Reads are available to any authenticated user (badges render across the
 * dashboard); writes are admin-gated at the server-fn layer (this repo does
 * not enforce RBAC).
 */

import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { badges } from "../schema";
import type { Badge, NewBadge } from "../schema";

const UPDATABLE_COLUMNS = ["slug", "label", "color", "textColor"] as const;

export async function listBadges(db: DbClient): Promise<Badge[]> {
  return db.select().from(badges).orderBy(asc(badges.label));
}

export async function getBadgeById(db: DbClient, id: number): Promise<Badge | null> {
  const rows = await db.select().from(badges).where(eq(badges.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getBadgeBySlug(db: DbClient, slug: string): Promise<Badge | null> {
  const rows = await db.select().from(badges).where(eq(badges.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function createBadge(db: DbClient, input: NewBadge): Promise<Badge> {
  const inserted = await db.insert(badges).values(input).returning();
  return inserted[0];
}

export async function updateBadge(
  db: DbClient,
  id: number,
  patch: Partial<Pick<Badge, "slug" | "label" | "color" | "textColor">>,
): Promise<Badge | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  UPDATABLE_COLUMNS.forEach((key) => {
    if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
      update[key] = (patch as Record<string, unknown>)[key];
    }
  });
  if (Object.keys(update).length === 1) {
    return getBadgeById(db, id);
  }
  const res = await db.update(badges).set(update).where(eq(badges.id, id)).returning();
  return res[0] ?? null;
}

export async function deleteBadge(db: DbClient, id: number): Promise<boolean> {
  const res = await db.delete(badges).where(eq(badges.id, id)).returning({ id: badges.id });
  return res.length > 0;
}
