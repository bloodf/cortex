/**
 * Build JSON-Schema files from every Zod schema in the contracts package.
 *
 * This script is invoked by `pnpm run build`. It walks the schema barrel
 * (`src/schemas/index.ts`) and emits one `*.json` per schema into
 * `dist/schemas-json/`. The output is consumed by:
 *
 *   - The SvelteKit mock layer (MSW handlers build valid responses from
 *     the JSON shape).
 *   - The SvelteKit `+server.ts` routes (return a `Response` whose body
 *     passes the JSON schema).
 *   - The `pnpm run test:contract` job (compares the schema used by
 *     the MSW handler with the schema used by the server route).
 *
 * The script is intentionally a separate `.mjs` file so it runs without
 * TypeScript compilation; it is invoked AFTER `tsc` has emitted
 * `dist/`, and it imports the compiled `*.js` files.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

const scriptPath = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(scriptPath), '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(DIST, 'schemas-json');
const SCHEMAS_INDEX_JS = join(DIST, 'schemas', 'index.js');

/**
 * Every schema name exported by the schemas barrel, mapped to a path-safe
 * filename. The keys must match the `export const X = ...` names in
 * `src/schemas/index.ts`. We curate this list explicitly so the JSON
 * filenames are stable and human-readable.
 */
const SCHEMAS = [
  // User
  'GroupMembershipSchema',
  'UserSchema',
  'UserInputSchema',
  'SessionSchema',
  'CurrentSessionSchema',
  'LoginInputSchema',
  'LoginResponseSchema',
  // Service
  'ServiceSchema',
  'ServiceInputSchema',
  'ServiceUpdateSchema',
  'ServiceCheckSchema',
  'ServiceHealthSnapshotSchema',
  'UptimeStatSchema',
  'UptimeIncidentSchema',
  'BadgeSchema',
  'BadgeInputSchema',
  'BadgeRefSchema',
  // System
  'SystemDataSchema',
  'MemorySchema',
  'DriveInfoSchema',
  'MountInfoSchema',
  'MachineSensorSchema',
  'NetworkDataSchema',
  'NetworkInterfaceSchema',
  'ProcessInfoSchema',
  // Docker
  'DockerContainerSchema',
  'DockerImageSchema',
  'DockerVolumeSchema',
  'DockerNetworkSchema',
  'DockerActionInputSchema',
  'DockerActionResultSchema',
  // Incus
  'IncusInstanceSchema',
  'IncusLiveInstanceSchema',
  'IncusImageSchema',
  'IncusInstanceConfigSchema',
  'ProgressStepSchema',
  'ProgressReportSchema',
  'IncusPreflightCheckSchema',
  'IncusPreflightReportSchema',
  'IncusShellInputSchema',
  'IncusShellResultSchema',
  'IncusActionInputSchema',
  'IncusActionResultSchema',
  'ProvisioningRequestSchema',
  'ProvisioningResultSchema',
  // Systemd
  'SystemdUnitSchema',
  'SystemdActionInputSchema',
  'SystemdActionResultSchema',
  'SystemdLogLineSchema',
  // Alert
  'AlertRuleSchema',
  'AlertRuleInputSchema',
  'AlertRuleUpdateSchema',
  'AlertEventSchema',
  'OperationalAlertSchema',
  // Approval + command audit
  'ApprovalRequestSchema',
  'ApprovalDecisionInputSchema',
  'DashboardCommandAuditSchema',
  'DashboardCommandCreateSchema',
  'DashboardCommandFinishSchema',
  // Terminal
  'TerminalSessionSchema',
  'TerminalActionSchema',
  'TerminalCommandSchema',
  'EnvLineSchema',
  'EnvFileSchema',
  'EnvEditInputSchema',
  // Misc
  'ProjectSchema',
  'ProjectInputSchema',
  'ProjectUpdateSchema',
  'NotificationEntrySchema',
  'BackupSnapshotSchema',
  'ScheduledJobSchema',
  // Personalization + AI
  'AppPreferenceSchema',
  'DashboardLayoutSchema',
  'WidgetConfigSchema',
  'WidgetPositionSchema',
  'LogEntrySchema',
  'AIToolDefinitionSchema',
  'AIRequestSchema',
  'AIResponseSchema',
  'AIResponseChunkSchema',
  'MailReviewSchema',
  'MailDecisionInputSchema',
  'AgentSchema',
  'AgentFileSchema',
  'AgentFileContentSchema',
  // Primitives (camelCase variants of zod helpers)
  // These are also worth exporting as JSON for OpenAPI generation.
  // Page + filter (from query.ts)
  'PageInputSchema',
  'PageSchema',
  'SortSpecSchema',
  'FilterSchema',
  'FilterClauseSchema',
  // Errors
  'CortexErrorSchema',
  'ErrorCodeSchema',
  // Audit
  'AuditEventSchema',
  'AuditEntrySchema',
  // Approval
  'ApprovalRequestPayloadSchema',
  'ApprovalResponseSchema',
  'ApprovalClaimsSchema',
  'ApprovalTokenSchema',
  // Primitives
  // (zId, zUuidV4, etc. are NOT exported as ZodSchema instances; they
  // are factory functions, so they don't appear in this list.)
];

const main = async () => {
  if (!existsSync(DIST)) {
    throw new Error(`✖ dist/ not found at ${DIST}. Run \`pnpm run build\` first (tsc).`);
  }
  if (!existsSync(SCHEMAS_INDEX_JS)) {
    throw new Error(`✖ compiled schemas barrel not found at ${SCHEMAS_INDEX_JS}.`);
  }
  await mkdir(OUT_DIR, { recursive: true });

  const mod = await import(pathToFileURL(SCHEMAS_INDEX_JS).href);

  const results = await Promise.all(
    SCHEMAS.map(async (name) => {
      const schema = mod[name];
      if (!schema || typeof schema !== 'object' || !('_def' in schema)) {
        return { name, ok: false };
      }
      const jsonSchema = zodToJsonSchema(schema, {
        // No `name`: a named Zod schema would generate a self-referencing
        // $ref to an empty `definitions.X` block, which is wrong.
        // Without `name`, the schema is fully inlined and self-contained.
        $refStrategy: 'none',
        target: 'jsonSchema7',
        definitions: {},
        errorMessages: false,
        markdownDescription: false,
      });
      const outFile = join(OUT_DIR, `${name}.json`);
      await writeFile(outFile, `${JSON.stringify(jsonSchema, null, 2)}\n`, 'utf8');
      return { name, ok: true };
    }),
  );

  const skipped = results.filter((r) => !r.ok).map((r) => r.name);
  const written = results.filter((r) => r.ok).length;

  // Emit an index.json for consumers that want to enumerate everything.
  const indexFile = join(OUT_DIR, 'index.json');
  const indexBody = {
    generatedAt: new Date().toISOString(),
    count: written,
    schemas: SCHEMAS.filter((n) => !skipped.includes(n)),
  };
  await writeFile(indexFile, `${JSON.stringify(indexBody, null, 2)}\n`, 'utf8');

  if (skipped.length > 0) {
    console.warn(
      `⚠ Skipped ${skipped.length} schema names (not exported or not Zod):`,
      skipped.join(', '),
    );
  }
  process.stdout.write(
    `✓ Wrote ${written} JSON-Schema files to ${OUT_DIR} (index: ${indexFile})\n`,
  );
};

main().catch((err) => {
  console.error('✖ build-json-schemas failed:', err);
  throw err;
});
