/**
 * Incus entities: Instance, Image, Shell, plus the action envelope.
 *
 * The `/api/incus/[name]/shell` route is one of the M0-B BLOCKERs
 * (PB-4, T-051). The contract enforces SR-020: no `bash -c <userstring>`
 * from the UI; every command is a named operation.
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const IncusInstanceStatusSchema = z.enum([
  'draft',
  'validated',
  'provisioning',
  'active',
  'failed',
  'running',
  'stopped',
  'frozen',
  'error',
]);
export type IncusInstanceStatus = z.infer<typeof IncusInstanceStatusSchema>;

/** The type of instance — Incus supports both containers and VMs. */
export const IncusInstanceTypeSchema = z.enum(['container', 'vm']);
export type IncusInstanceType = z.infer<typeof IncusInstanceTypeSchema>;

// ---------------------------------------------------------------------------
// Instance (DB-stored wizard config)
// ---------------------------------------------------------------------------

export const IncusInstanceConfigSchema = z.object({
  target: z.object({
    mode: z.enum(['new', 'clone']),
    repoUrl: z.string().url().optional(),
    branch: z.string().min(1).max(128).default('main'),
    ghOrg: z.string().min(1).max(64),
    slug: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
  }),
  image: z.object({
    alias: z.string().min(1).max(128),
    gastown: z.boolean().default(false),
    profiles: z.array(z.string().min(1).max(64)).default([]),
    cpu: z.number().int().min(1).max(256).optional(),
    memory: z.number().int().min(64).max(1_048_576).optional(),
    pool: z.string().min(1).max(64).optional(),
  }),
  hermes: z.object({
    enabled: z.boolean().default(false),
    profile: z.string().min(1).max(64).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    model: z.string().min(1).max(128).optional(),
    proxies: z.array(z.string().min(1).max(128)).default([]),
  }),
  network: z.object({
    bridge: z.string().min(1).max(64),
    tailscale: z.boolean().default(false),
    tailscaleKeyRef: z.string().min(1).max(256).optional(),
    webAccess: z.boolean().default(false),
  }),
});
export type IncusInstanceConfig = z.infer<typeof IncusInstanceConfigSchema>;

/** The wizard's known step identifiers. The `profile` step is a no-op
 *  for now (no per-step validation surface yet — it's a UI-only
 *  summary of the chosen profiles from the image step). */
export const IncusWizardStepSchema = z.enum([
  'target',
  'image',
  'hermes',
  'network',
  'profile',
  'review',
]);
export type IncusWizardStep = z.infer<typeof IncusWizardStepSchema>;

export const IncusInstanceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/),
  status: IncusInstanceStatusSchema,
  type: IncusInstanceTypeSchema,
  image: z.string().min(1).max(256),
  cpu: z.number().int().min(0).max(256).nullable().optional(),
  memory: z.number().int().min(0).max(1_048_576).nullable().optional(),
  config: IncusInstanceConfigSchema,
  devices: z.record(z.string(), z.unknown()).default({}),
  lastValidation: z.record(z.string(), z.unknown()).nullable().optional(),
  createdBy: zUuidV4,
  createdAt: zIsoTimestamp,
  updatedAt: zIsoTimestamp,
});
export type IncusInstance = z.infer<typeof IncusInstanceSchema>;

// ---------------------------------------------------------------------------
// Live instance status (from `incus list`)
// ---------------------------------------------------------------------------

export const IncusLiveInstanceSchema = z.object({
  name: z.string().min(1).max(64),
  status: z.string().min(1).max(64), // `RUNNING`, `STOPPED`, etc.
  statusCode: IncusInstanceStatusSchema,
  type: IncusInstanceTypeSchema,
  architecture: z.string().min(1).max(32),
  createdAt: zIsoTimestamp,
  state: z.object({
    networks: z
      .record(
        z.string(),
        z.object({
          addresses: z.array(
            z.object({
              family: z.enum(['inet', 'inet6']),
              address: z.string().min(1).max(64),
              scope: z.enum(['global', 'link', 'local']).optional(),
            }),
          ),
          state: z.string().max(32).optional(),
          type: z.string().max(32).optional(),
        }),
      )
      .default({}),
    pid: z.number().int().min(0).optional(),
  }),
  profiles: z.array(z.string()).default([]),
  snapshots: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        createdAt: zIsoTimestamp,
        stateful: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type IncusLiveInstance = z.infer<typeof IncusLiveInstanceSchema>;

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export const IncusImageSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{12,64}$/),
  architecture: z.string().min(1).max(32),
  type: z.enum(['container', 'virtual-machine', 'unknown']),
  size: z.number().int().min(0),
  uploadedAt: zIsoTimestamp,
  aliases: z.array(z.string().min(1).max(128)).default([]),
  description: z.string().max(2000).nullable().optional(),
});
export type IncusImage = z.infer<typeof IncusImageSchema>;

// ---------------------------------------------------------------------------
// Provisioning / preflight
// ---------------------------------------------------------------------------

export const ProgressStepSchema = z.object({
  step: z.string().min(1).max(128),
  status: z.enum(['ok', 'done', 'error', 'failed', 'pending', 'running']),
  n: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
  detail: z.string().max(2000).optional(),
});
export type ProgressStep = z.infer<typeof ProgressStepSchema>;

export const ProgressReportSchema = z.object({
  status: IncusInstanceStatusSchema,
  requestId: zUuidV4,
  steps: z.array(ProgressStepSchema).default([]),
});
export type ProgressReport = z.infer<typeof ProgressReportSchema>;

export const IncusPreflightCheckSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(256),
  pass: z.boolean(),
  detail: z.string().max(1000).optional(),
});
export type IncusPreflightCheck = z.infer<typeof IncusPreflightCheckSchema>;

export const IncusPreflightReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(IncusPreflightCheckSchema),
});
export type IncusPreflightReport = z.infer<typeof IncusPreflightReportSchema>;

// ---------------------------------------------------------------------------
// Shell / named exec (SR-020 / SR-051)
// ---------------------------------------------------------------------------

/**
 * The closed set of named shell operations the UI may invoke. Anything
 * outside this set returns 400 with `unsupported_command`. This is the
 * core of THREAT_MODEL §4.4.1 — no `bash -c <userstring>` from the UI.
 */
export const IncusShellOpSchema = z.enum([
  'term.ps', // ps auxf
  'term.df', // df -h
  'term.ls', // ls -la <path>
  'term.cat', // cat <path>
  'term.tail_log', // journalctl -u <unit> -n <N> --no-pager
]);
export type IncusShellOp = z.infer<typeof IncusShellOpSchema>;

export const IncusShellInputSchema = z.object({
  op: IncusShellOpSchema,
  /** Args object whose shape is op-specific. */
  args: z
    .object({
      path: z.string().min(1).max(512).optional(),
      unit: z.string().min(1).max(128).optional(),
      n: z.number().int().min(1).max(1000).optional(),
      command: z.string().min(1).max(64).optional(),
    })
    .default({}),
});
export type IncusShellInput = z.infer<typeof IncusShellInputSchema>;

export const IncusShellResultSchema = z.object({
  stdout: z.string().max(64_000).default(''),
  stderr: z.string().max(64_000).default(''),
  exitCode: z.number().int().min(-1).max(255).optional(),
});
export type IncusShellResult = z.infer<typeof IncusShellResultSchema>;

// ---------------------------------------------------------------------------
// Incus action envelope (start/stop/restart/delete)
// ---------------------------------------------------------------------------

export const IncusActionKindSchema = z.enum([
  'start',
  'stop',
  'restart',
  'delete',
  'launch',
  'list',
  'exec-named',
]);
export type IncusActionKind = z.infer<typeof IncusActionKindSchema>;

export const IncusActionInputSchema = z.object({
  action: IncusActionKindSchema,
  name: z.string().min(1).max(64),
  /** For `delete`: the typed-phrase the user confirmed. */
  confirmation: z.string().min(1).max(256).optional(),
});
export type IncusActionInput = z.infer<typeof IncusActionInputSchema>;

export const IncusActionResultSchema = z.object({
  stdout: z.string().max(64_000).default(''),
  stderr: z.string().max(64_000).default(''),
  exitCode: z.number().int().min(-1).max(255).optional(),
});
export type IncusActionResult = z.infer<typeof IncusActionResultSchema>;

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export const ProvisioningRequestSchema = z.object({
  /** Optional body — server uses the saved config keyed by name. */
  note: z.string().max(1000).optional(),
});
export type ProvisioningRequest = z.infer<typeof ProvisioningRequestSchema>;

export const ProvisioningResultSchema = z.object({
  success: z.boolean(),
  requestId: zUuidV4,
  data: ProgressReportSchema,
});
export type ProvisioningResult = z.infer<typeof ProvisioningResultSchema>;
