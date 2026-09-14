/**
 * Backups — server functions (MP-024b).
 *
 * Transport is createServerFn RPC (ADR-001). The gate carries auth/RBAC/audit
 * and dynamically imports the server-only backups bridge so the client bundle
 * never pulls in `src/server/**`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";
import type { BackupRunRow } from "@/server/backups";

// ---------------------------------------------------------------------------
// listBackupRuns — GET, auth: any → { backups: BackupRunRow[] }
// ---------------------------------------------------------------------------

const listBackupRunsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  surface: "backups",
  action: "backups.list",
  handler: async () => {
    const { listBackupRuns: listBackupRunsBridge } = await import("@/server/backups");
    const rows = await listBackupRunsBridge();
    return { backups: rows };
  },
});

export const listBackupRuns = createServerFn({ method: "GET" })
  .middleware([listBackupRunsGate])
  .handler(serverFnNoop);

export type { BackupRunRow };
