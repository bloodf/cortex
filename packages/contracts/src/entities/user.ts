/**
 * Identity entities: User, Session, Group.
 *
 * The dashboard authenticates via Linux PAM (per THREAT_MODEL §0.5 / §7);
 * `User` is the dashboard's projection of an OS account, and `Session` is
 * the cookie-backed web session. The `isAdmin` derivation lives in
 * `entities/admin.ts` and is re-exported via the `cortexos-admin` group.
 *
 * @module
 */
import { z } from 'zod';
import { zUuidV4, zIsoTimestamp } from '../primitives.js';

// ---------------------------------------------------------------------------
// Group membership
// ---------------------------------------------------------------------------

/**
 * A user can be a member of one or more POSIX groups. The dashboard
 * consults these on every privileged call. `cortexos-admin` is the only
 * admin-bearing group per THREAT_MODEL §0.5 (P3: single source of truth).
 * `sudo` / `wheel` are *not* allowed (SR-003).
 */
export const GroupMembershipSchema = z.object({
  /** Group name as it appears in the OS `getgrouplist` output. */
  name: z.string().min(1).max(64),
  /** Optional human-readable description. */
  description: z.string().max(256).optional(),
  /** Whether the group grants admin privileges. */
  isAdmin: z.boolean().default(false),
});
export type GroupMembership = z.infer<typeof GroupMembershipSchema>;

/** The exact string of the admin-bearing group. Hard-coded per SR-003. */
export const ADMIN_GROUP_NAME = 'cortexos-admin' as const;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export const UserStatusSchema = z.enum(['active', 'suspended', 'disabled']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserSchema = z.object({
  id: zUuidV4,
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z_][a-z0-9_-]{0,63}$/),
  /** True iff user is a member of the admin group (SR-003). */
  isAdmin: z.boolean(),
  isActive: z.boolean().default(true),
  status: UserStatusSchema.default('active'),
  groupMemberships: z.array(GroupMembershipSchema).default([]),
  createdAt: zIsoTimestamp,
  lastLoginAt: zIsoTimestamp.nullable(),
  /** Active session count (denormalized; not security-critical). */
  activeSessions: z.number().int().min(0).default(0),
});
export type User = z.infer<typeof UserSchema>;

export const UserInputSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z_][a-z0-9_-]{0,63}$/),
  password: z.string().min(1).max(512), // PAM validates; this is just a transport field
});
export type UserInput = z.infer<typeof UserInputSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  id: zUuidV4,
  userId: zUuidV4,
  /** Server-derived CSRF token bound to the session (SR-004). */
  csrfToken: z.string().min(32).max(128),
  /** Server-derived `__Host-` cookie token (SR-001). */
  cookieToken: z.string().min(32).max(128),
  expiresAt: zIsoTimestamp,
  createdAt: zIsoTimestamp,
  lastSeenAt: zIsoTimestamp,
  ip: z.string().min(1).max(64).nullable(),
  userAgent: z.string().min(0).max(1024).nullable(),
  /** Whether the session has admin privileges (cached for 60s per SR-011). */
  isAdmin: z.boolean(),
  /** Cached role-check timestamp (ms epoch) — server revalidates > 60s. */
  lastRoleCheck: z.number().int().min(0).max(8_640_000_000_000),
});
export type Session = z.infer<typeof SessionSchema>;

/** What `GET /api/auth` returns to the client. */
export const CurrentSessionSchema = z.object({
  user: UserSchema,
  session: SessionSchema,
});
export type CurrentSession = z.infer<typeof CurrentSessionSchema>;

// ---------------------------------------------------------------------------
// Auth input
// ---------------------------------------------------------------------------

export const LoginInputSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

/** Server response on successful login. */
export const LoginResponseSchema = z.object({
  success: z.literal(true),
  username: z.string().min(1).max(64),
  user: UserSchema.optional(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
