/**
 * Admin RPC adapter (WP-40).
 *
 * Calls the WP-10 services + WP-18 env-browser + WP-20 auth server functions
 * DIRECTLY (typed createServerFn RPC, NOT fetch — ADR-001). The gate-middleware
 * pattern (`defineServerFn` + `serverFnNoop`) means TypeScript infers the outer
 * createServerFn return as `undefined`; the real payload is carried by the gate
 * at runtime. We recover the typed shapes with a single `unknown` cast at this
 * boundary (same technique as `src/lib/api/client.ts`), so every admin call
 * site stays fully typed.
 *
 * Mutations (POST fns) attach the session-bound CSRF header via `csrfHeaders()`.
 */

import type { Service as ContractService, User } from "@cortexos/contracts/entities";
import {
  listServices as _listServices,
  createService as _createService,
  patchService as _patchService,
  deleteService as _deleteService,
} from "@/lib/api/services.functions";
import {
  listEnvFiles as _listEnvFiles,
  readEnv as _readEnv,
  unlock as _unlock,
  updateEnv as _updateEnv,
} from "@/lib/api/env-browser.functions";
import { me as _me } from "@/lib/api/auth.functions";
import {
  listBadges as _listBadges,
  createBadge as _createBadge,
  patchBadge as _patchBadge,
  deleteBadge as _deleteBadge,
} from "@/lib/api/badges.functions";
import {
  listProjects as _listProjects,
  createProject as _createProject,
  patchProject as _patchProject,
  deleteProject as _deleteProject,
} from "@/lib/api/projects.functions";

import { toServiceRow, type ServiceRowInput } from "@/lib/adapters/services";
import type { Service as MockService } from "@/mocks/types";

import { csrfHeaders } from "@/lib/csrf";

// ---------------------------------------------------------------------------
// Typed boundaries (recover payloads erased by the gate-middleware pattern)
// ---------------------------------------------------------------------------

interface ServiceCreateData {
  slug: string;
  name: string;
  description?: string | null;
  healthUrl?: string | null;
  healthType?: "http" | "tcp" | "docker" | "systemd" | "process";
  category: string;
  openUrl?: string | null;
  kind?: "app" | "service" | "docker" | "process" | "dashboard-launcher";
}

type ServicePatchData = Partial<ServiceCreateData> & {
  id: number;
  isActive?: boolean;
  sortOrder?: number;
  showInHealthcheck?: boolean;
  showInWebui?: boolean;
};

const listServicesFn = _listServices as unknown as (opts: {
  data: { activeOnly?: boolean; page?: number; pageSize?: number };
}) => Promise<{ rows: ServiceRowInput[]; total: number }>;

const createServiceFn = _createService as unknown as (opts: {
  data: ServiceCreateData;
  headers?: Record<string, string>;
}) => Promise<ContractService>;

const patchServiceFn = _patchService as unknown as (opts: {
  data: ServicePatchData;
  headers?: Record<string, string>;
}) => Promise<ContractService>;

const deleteServiceFn = _deleteService as unknown as (opts: {
  data: { id: number };
  headers?: Record<string, string>;
}) => Promise<{ ok: true }>;

interface EnvEntry {
  key: string;
  value: string;
  masked: string;
}
interface ReadEnvResult {
  path: string;
  revealed: boolean;
  revealExpiresAt: number | null;
  entries: EnvEntry[];
}
const listEnvFilesFn = _listEnvFiles as unknown as (opts: {
  data: Record<string, never>;
}) => Promise<{ files: string[] }>;

export async function listAdminEnvFiles(): Promise<string[]> {
  return (await listEnvFilesFn({ data: {} })).files;
}
const readEnvFn = _readEnv as unknown as (opts: {
  data: { path: string };
}) => Promise<ReadEnvResult>;

const unlockFn = _unlock as unknown as (opts: {
  data: { password: string };
  headers?: Record<string, string>;
}) => Promise<{ ok: true; expiresAt: number; ttlSec: number }>;

const meFn = _me as unknown as (opts: {
  data?: Record<string, never>;
}) => Promise<{ user: User | null; session: unknown | null }>;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** All services (admin sees everything — no `activeOnly` filter). */
export async function listAdminServices(): Promise<MockService[]> {
  const { rows } = await listServicesFn({ data: { pageSize: 500 } });
  return rows.map(toServiceRow);
}

export function createAdminService(data: ServiceCreateData): Promise<ContractService> {
  return createServiceFn({ data, headers: csrfHeaders() });
}

export function patchAdminService(data: ServicePatchData): Promise<ContractService> {
  return patchServiceFn({ data, headers: csrfHeaders() });
}

export function deleteAdminService(id: number): Promise<{ ok: true }> {
  return deleteServiceFn({ data: { id }, headers: csrfHeaders() });
}

export type { ServiceCreateData, ServicePatchData };

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

interface BadgeRow {
  id: number;
  slug: string;
  label: string;
  color: string;
  textColor: string;
}
interface BadgeCreateData {
  slug: string;
  label: string;
  color: string;
  textColor: string;
}
type BadgePatchData = Partial<BadgeCreateData> & { id: number };

const listBadgesFn = _listBadges as unknown as (opts: {
  data: Record<string, never>;
}) => Promise<{ rows: BadgeRow[] }>;
const createBadgeFn = _createBadge as unknown as (opts: {
  data: BadgeCreateData;
  headers?: Record<string, string>;
}) => Promise<BadgeRow>;
const patchBadgeFn = _patchBadge as unknown as (opts: {
  data: BadgePatchData;
  headers?: Record<string, string>;
}) => Promise<BadgeRow>;
const deleteBadgeFn = _deleteBadge as unknown as (opts: {
  data: { id: number };
  headers?: Record<string, string>;
}) => Promise<{ ok: true }>;

export async function listAdminBadges(): Promise<BadgeRow[]> {
  const { rows } = await listBadgesFn({ data: {} });
  return rows;
}
export function createAdminBadge(data: BadgeCreateData): Promise<BadgeRow> {
  return createBadgeFn({ data, headers: csrfHeaders() });
}
export function patchAdminBadge(data: BadgePatchData): Promise<BadgeRow> {
  return patchBadgeFn({ data, headers: csrfHeaders() });
}
export function deleteAdminBadge(id: number): Promise<{ ok: true }> {
  return deleteBadgeFn({ data: { id }, headers: csrfHeaders() });
}
export type { BadgeRow, BadgeCreateData, BadgePatchData };

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

type MessagingMode = "single" | "distributed";
interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  repoUrl: string | null;
  primaryPmAccount: string | null;
  messagingMode: MessagingMode;
}
interface ProjectCreateData {
  slug: string;
  name: string;
  repoUrl: string | null;
  primaryPmAccount: string | null;
  messagingMode: MessagingMode;
}
type ProjectPatchData = Partial<ProjectCreateData> & { id: number };

const listProjectsFn = _listProjects as unknown as (opts: {
  data: Record<string, never>;
}) => Promise<{ rows: ProjectRow[] }>;
const createProjectFn = _createProject as unknown as (opts: {
  data: ProjectCreateData;
  headers?: Record<string, string>;
}) => Promise<ProjectRow>;
const patchProjectFn = _patchProject as unknown as (opts: {
  data: ProjectPatchData;
  headers?: Record<string, string>;
}) => Promise<ProjectRow>;
const deleteProjectFn = _deleteProject as unknown as (opts: {
  data: { id: number };
  headers?: Record<string, string>;
}) => Promise<{ ok: true }>;

export async function listAdminProjects(): Promise<ProjectRow[]> {
  const { rows } = await listProjectsFn({ data: {} });
  return rows;
}
export function createAdminProject(data: ProjectCreateData): Promise<ProjectRow> {
  return createProjectFn({ data, headers: csrfHeaders() });
}
export function patchAdminProject(data: ProjectPatchData): Promise<ProjectRow> {
  return patchProjectFn({ data, headers: csrfHeaders() });
}
export function deleteAdminProject(id: number): Promise<{ ok: true }> {
  return deleteProjectFn({ data: { id }, headers: csrfHeaders() });
}
export type { ProjectRow, ProjectCreateData, ProjectPatchData, MessagingMode };

// ---------------------------------------------------------------------------
// Env browser
// ---------------------------------------------------------------------------

export type { EnvEntry, ReadEnvResult };

/** Read an allowlisted env file. Values are masked unless a reveal grant is live. */
export function readAdminEnv(path: string): Promise<ReadEnvResult> {
  return readEnvFn({ data: { path } });
}

/**
 * PAM step-up: re-prove the operator's password to open a 10-minute reveal
 * window bound to this session. The password is sent once and never stored.
 */
export function unlockAdminEnv(
  password: string,
): Promise<{ ok: true; expiresAt: number; ttlSec: number }> {
  return unlockFn({ data: { password }, headers: csrfHeaders() });
}

const updateEnvFn = _updateEnv as unknown as (opts: {
  data: { path: string; key: string; value: string };
  headers?: Record<string, string>;
}) => Promise<{ ok: true }>;

/**
 * Write a single KEY=value back to an allowlisted env file. Requires a live
 * reveal grant (server-enforced) — the operator must unlock the file first.
 */
export function updateAdminEnv(path: string, key: string, value: string): Promise<{ ok: true }> {
  return updateEnvFn({ data: { path, key, value }, headers: csrfHeaders() });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** Current user + session. `auth: public` — returns `{ user: null }` when unauthenticated. */
export function getMe(): Promise<{ user: User | null; session: unknown | null }> {
  return meFn({ data: {} });
}
