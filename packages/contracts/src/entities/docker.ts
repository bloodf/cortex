/**
 * Docker entities: Container, Image, Volume, Network, plus the action
 * envelope that backs `/api/docker/actions` (admin-only, THREAT_MODEL
 * §4.4.3 + SR-030/SR-042).
 *
 * @module
 */
import { z } from 'zod';
import { zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const DockerContainerStateSchema = z.enum([
  'running',
  'exited',
  'paused',
  'restarting',
  'dead',
  'created',
  'removing',
]);
export type DockerContainerState = z.infer<typeof DockerContainerStateSchema>;

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export const DockerContainerSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$|^[0-9a-f]{12,64}$/),
  name: z.string().min(1).max(128),
  image: z.string().min(1).max(512),
  state: DockerContainerStateSchema,
  /** Free-form status text (e.g. "Up 3 days", "Exited (0) 2 hours ago"). */
  status: z.string().max(256).nullable().optional(),
  ports: z.array(z.string().max(64)).default([]),
  created: zIsoTimestamp,
  /** Whether the container is running with `--privileged`. Sensitive (SR-042). */
  privileged: z.boolean().default(false),
  /** Comma-separated list of networks the container is attached to. */
  networks: z.array(z.string().max(64)).default([]),
  /** Comma-separated volume bindings (host:container[:ro]). */
  mounts: z
    .array(
      z.object({
        source: z.string().max(256),
        destination: z.string().max(256),
        mode: z.string().max(8),
      }),
    )
    .default([]),
});
export type DockerContainer = z.infer<typeof DockerContainerSchema>;

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export const DockerImageSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  repo: z.string().min(0).max(256),
  tag: z.string().min(0).max(64),
  size: z.number().int().min(0),
  created: zIsoTimestamp,
});
export type DockerImage = z.infer<typeof DockerImageSchema>;

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export const DockerVolumeSchema = z.object({
  name: z.string().min(1).max(128),
  driver: z.string().min(1).max(64),
  mountpoint: z.string().min(1).max(512),
  /** Bytes; null if not yet measured. */
  size: z.number().int().min(0).nullable().optional(),
  createdAt: zIsoTimestamp.nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
});
export type DockerVolume = z.infer<typeof DockerVolumeSchema>;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const DockerNetworkSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  driver: z.string().min(1).max(64),
  scope: z.enum(['local', 'global', 'swarm']),
});
export type DockerNetwork = z.infer<typeof DockerNetworkSchema>;

// ---------------------------------------------------------------------------
// Docker action envelope
// ---------------------------------------------------------------------------

/** The set of admin actions the dashboard may perform. Closed set. */
export const DockerActionKindSchema = z.enum([
  'start',
  'stop',
  'restart',
  'rm',
  'logs',
  'inspect',
  'list',
  'pull', // SR-041: gated by `policy.json` registry allowlist, not freeform
  'prune',
]);
export type DockerActionKind = z.infer<typeof DockerActionKindSchema>;

/**
 * The Docker action input. The `name` is the container name; the server
 * validates it against the allowlist (SR-030) and a homoglyph check
 * (T-030: reject Cyrillic `е` in `systеmd-resolved`).
 *
 * For `pull`, `target` is the *registry-allowlisted* image reference — the
 * server rejects anything not in `policy.json`.
 */
export const DockerActionInputSchema = z
  .object({
    action: DockerActionKindSchema,
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
    target: z.string().min(1).max(256).optional(),
  })
  .refine((v) => v.action === 'pull' || v.action === 'list' || typeof v.name === 'string', {
    message: 'name is required for non-pull/non-list actions',
  });
export type DockerActionInput = z.infer<typeof DockerActionInputSchema>;

export const DockerActionResultSchema = z.object({
  stdout: z.string().max(64_000).default(''),
  stderr: z.string().max(64_000).default(''),
  exitCode: z.number().int().min(-1).max(255).optional(),
});
export type DockerActionResult = z.infer<typeof DockerActionResultSchema>;
