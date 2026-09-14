/**
 * Shared zod schemas used by more than one `*.functions.ts` server-fn module.
 *
 * These MUST live outside any `*.functions.ts` file. A `*.functions.ts` module
 * importing another `*.functions.ts` module makes the TanStack Start server-fn
 * build emit duplicate copies of the imported module — the server then
 * registers a fn's handler under one copy while the client calls the id of the
 * other, yielding `Server function info not found for <fn>` at runtime (this
 * once broke agentChat due to cross-module schema sharing). Keep cross-module
 * schema sharing here instead.
 */
import { z } from "zod";

/** Reusable profile-slug schema (lowercase alnum, underscore, hyphen). */
export const slugSchema = () =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_-]+$/, "slug must be lowercase letters, numbers, underscores and hyphens");
