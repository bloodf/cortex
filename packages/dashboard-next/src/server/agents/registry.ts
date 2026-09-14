/**
 * Hermes profiles registry reader (WP-21).
 *
 * Reads HERMES_PROFILES_REGISTRY (default: data root / hermes / profiles.json)
 * and exposes the parsed profile list. Each entry from the registry JSON is
 * typed; the `home` field is the profile directory used for scoped file ops.
 *
 * No caching — reads the filesystem on every call (Wave-4 optimisation).
 */

import fs from "node:fs";
import { dashboardPaths } from "@/server/paths";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry from profiles.json `profiles` array. */
export interface HermesProfile {
  /** Profile slug — e.g. "operator". */
  profile: string;
  runtime?: "hermes" | "openclaw";
  unitName?: string;
  /** Absolute path to this profile's home directory. */
  home: string;
  /** Hermes API port for this profile. */
  apiPort?: number;
  /** Model ID, e.g. "cx/gpt-5.5". */
  model?: string;
  /** Reasoning level, e.g. "medium". */
  reasoning?: string;
  /** Hindsight bank id. */
  hindsightBank?: string;
  /** Path to secrets env file. */
  secretPath?: string;
  /** Associated app slugs. */
  apps?: string[];
}

/** Shape of profiles.json. */
interface ProfilesRegistry {
  profiles: HermesProfile[];
}

// ---------------------------------------------------------------------------
// Registry path
// ---------------------------------------------------------------------------

export function getRegistryPath(): string {
  return dashboardPaths().registry;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Read and parse the profiles registry JSON.
 * Returns an empty array if the file is missing or unreadable.
 */
export function readRegistry(): HermesProfile[] {
  const registryPath = getRegistryPath();
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as ProfilesRegistry;
    if (!Array.isArray(parsed?.profiles)) return [];
    return parsed.profiles.filter(
      (p) => typeof p.profile === "string" && typeof p.home === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Find a single profile by slug. Returns null if not found.
 */
export function findProfileBySlug(slug: string): HermesProfile | null {
  return readRegistry().find((p) => p.profile === slug) ?? null;
}

/**
 * Persist an updated `model` / `reasoning` for a profile back to the registry
 * JSON (P1.3: setAgentModel). Writes atomically (tmp + rename). Throws if the
 * registry is missing or the slug is absent — callers should have already
 * validated the slug via `findProfileBySlug`.
 */
export function updateProfileModel(
  slug: string,
  patch: { model?: string; reasoning?: string },
): void {
  const registryPath = getRegistryPath();
  const raw = fs.readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw) as ProfilesRegistry;
  const entry = parsed.profiles.find((p) => p.profile === slug);
  if (!entry) {
    throw new Error(`profile '${slug}' not found in registry`);
  }
  if (patch.model !== undefined) entry.model = patch.model;
  if (patch.reasoning !== undefined) entry.reasoning = patch.reasoning;
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  const tmp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o644 });
  fs.renameSync(tmp, registryPath);
}
