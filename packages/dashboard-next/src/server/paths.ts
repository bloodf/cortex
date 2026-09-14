import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

function configuredPath(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

/** Read configuration at use time, including isolated test environments. */
export function dashboardPaths() {
  const root = configuredPath("CORTEX_ROOT", "/opt/cortex");
  const dataRoot = configuredPath("CORTEX_DATA_ROOT", "/var/lib/cortex");
  return {
    root,
    dataRoot,
    secrets: configuredPath("CORTEX_SECRETS_DIR", "/etc/cortex/secrets"),
    stacks: join(root, "stacks"),
    docs: configuredPath("CORTEX_NOTES_DOCS_ROOT", join(root, "docs")),
    prompts: configuredPath("CORTEX_NOTES_PROMPTS_ROOT", join(root, "prompts")),
    registry: configuredPath("HERMES_PROFILES_REGISTRY", join(dataRoot, "hermes", "profiles.json")),
    backups: configuredPath("CORTEX_BACKUP_ROOT", join(dataRoot, "backups")),
    home: configuredPath("CORTEX_HARNESS_HOME", homedir()),
  };
}

/** Canonicalize trusted roots before comparing canonical file paths. */
export async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return null;
    }
  }));
  return resolved.filter((root): root is string => root !== null);
}

export function isWithinRoot(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
