/**
 * Projects repository.
 *
 * A project groups Incus instances + messaging routes under a slug. Reads are
 * available to any authenticated user; writes are admin-gated at the server-fn
 * layer (this repo does not enforce RBAC).
 */

import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { projects } from "../schema";
import type { Project, NewProject } from "../schema";

const UPDATABLE_COLUMNS = ["slug", "name", "repoUrl", "primaryPmAccount", "messagingMode"] as const;

export async function listProjects(db: DbClient): Promise<Project[]> {
  return db.select().from(projects).orderBy(asc(projects.name));
}

export async function getProjectById(db: DbClient, id: number): Promise<Project | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getProjectBySlug(db: DbClient, slug: string): Promise<Project | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function createProject(db: DbClient, input: NewProject): Promise<Project> {
  const inserted = await db.insert(projects).values(input).returning();
  return inserted[0];
}

export async function updateProject(
  db: DbClient,
  id: number,
  patch: Partial<Pick<Project, "slug" | "name" | "repoUrl" | "primaryPmAccount" | "messagingMode">>,
): Promise<Project | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  UPDATABLE_COLUMNS.forEach((key) => {
    if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
      update[key] = (patch as Record<string, unknown>)[key];
    }
  });
  if (Object.keys(update).length === 1) {
    return getProjectById(db, id);
  }
  const res = await db.update(projects).set(update).where(eq(projects.id, id)).returning();
  return res[0] ?? null;
}

export async function deleteProject(db: DbClient, id: number): Promise<boolean> {
  const res = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  return res.length > 0;
}
