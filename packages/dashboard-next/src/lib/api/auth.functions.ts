/**
 * Auth — server functions (WP-20). SECURITY-SENSITIVE.
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/audit + the business handler. All server-only logic (PAM, session
 * store, cookie helpers, errors) is imported DYNAMICALLY inside each handler so
 * import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers (read verbatim):
 *   packages/dashboard/src/routes/api/auth/login/+server.ts   (login)
 *   packages/dashboard/src/routes/api/auth/logout/+server.ts  (logout)
 *   packages/dashboard/src/routes/api/auth/me/+server.ts       (me)
 *
 *   - login   POST, auth 'public' — PAM verify → cortexos-admin group derive →
 *             CSRF token mint → session create → set session + CSRF cookies →
 *             { user, session }. Coarse failure only (no user-enumeration);
 *             passwords are NEVER logged.
 *   - logout  POST, auth 'any' — delete the session row + clear both cookies.
 *             Idempotent.
 *   - me      GET, auth 'public' — return { user, session } from ctx, or
 *             { user: null, session: null } when unauthenticated.
 *
 * Frontend (Wave 2) calls these typed:
 *   await login({ data: { username, password } })
 *   await logout({})
 *   await me({})
 *
 * Cookie mechanics: the cookie helpers write to `ctx.cookies` (the request's
 * WebCookieJar). `server-fn-pipeline.finalize()` applies that jar's pending
 * Set-Cookie headers to the response; `server-fn-runner.server.ts` replays them
 * onto the live runtime response via the framework `setCookie`. We therefore
 * never touch the framework cookie API directly here (per WP-20 / ADR-001).
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop, type ServerFnOptions } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas (mirror the legacy zod validation; never log the password)
// ---------------------------------------------------------------------------

const LoginInput = z
  .object({
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z_][a-z0-9_-]*$/, "invalid username"),
    password: z.string().min(1).max(1024),
  })
  .strict();

// ---------------------------------------------------------------------------
// login — POST, auth: public → { user, session }
//
// The login flow lives entirely in the handler because the request is
// pre-session: PAM verify, group check, session create, set cookies. On a PAM
// or group failure we throw a COARSE auth error (no user-enumeration); the
// pipeline audits it as `denied`. On success the pipeline audits `success`.
// ---------------------------------------------------------------------------

type LoginInputT = z.infer<typeof LoginInput>;

/**
 * Login gate options. Exported so the node-env test can drive the REAL handler
 * through the `defineApiRoute` pipeline (the createServerFn transform only runs
 * in the Vite/Nitro build) — a single source of truth for the gate + handler.
 */
export const loginGateOptions: ServerFnOptions<LoginInputT, { user: unknown; session: unknown }> = {
  method: "POST",
  auth: "public",
  input: LoginInput,
  // Per-IP bucket so a wrong-username probe cannot enumerate via rate-limit
  // timing differences (WP-20: bucket 'ip', strict).
  rateLimit: { limit: 5, windowSec: 60, bucket: "ip" },
  surface: "auth",
  action: "auth.login",
  // Audit target is the username (never the password).
  target: (input) => input.username,
  handler: async ({ input, ctx }) => {
    const { getPamAuthenticator } = await import("@/server/auth/pam");
    const { getSessionStore } = await import("@/server/auth/session-store");
    const { generateCsrfToken, setSessionCookie, setCsrfCookie } =
      await import("@/server/auth/cookies");
    const { authError } = await import("@/server/errors/types");

    // 1. Authenticate via PAM. Coarse failure only — do NOT reveal whether
    //    the username exists vs the password is wrong (THREAT_MODEL T-101).
    const pam = getPamAuthenticator();
    const auth = await pam.authenticate(input.username, input.password);
    if (!auth.ok) {
      throw authError("Invalid credentials");
    }

    // 2. Group lookup → admin derive. cortexos-admin is the ONLY admin-
    //    bearing group (SR-003). A valid system user who is not in
    //    cortexos-admin still gets a session (cortexos-users) — RBAC gates
    //    on subsequent admin routes deny them; this matches the legacy
    //    handler, which issued a session for any authenticated user.
    const groups = await pam.getGroups(auth.username);
    const isAdmin = groups.includes("cortexos-admin");

    // 3. Mint a session-bound CSRF token + create the session.
    const csrfToken = generateCsrfToken();
    const store = getSessionStore();
    const created = await store.createSession({
      username: auth.username,
      csrfToken,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
      isAdmin,
    });

    // 4. Set cookies via the request cookie jar. The pipeline replays these
    //    as Set-Cookie. Session cookie is HttpOnly; CSRF cookie is JS-readable
    //    (double-submit pattern).
    setSessionCookie(ctx.cookies, created.token);
    setCsrfCookie(ctx.cookies, csrfToken);

    return { user: created.user, session: created.session };
  },
};
const loginGate = defineServerFn(loginGateOptions);
export const login = createServerFn({ method: "POST" })
  .middleware([loginGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// logout — POST, auth: any → { ok: true }
//
// auth 'any' means the pipeline requires a session AND enforces the CSRF
// double-submit before the handler runs (a stolen cookie alone cannot log out
// another user). The handler deletes the session row and clears both cookies.
// ---------------------------------------------------------------------------

/** Logout gate options (exported for the node-env test — see loginGateOptions). */
export const logoutGateOptions: ServerFnOptions<unknown, { ok: true }> = {
  method: "POST",
  auth: "any",
  surface: "auth",
  action: "auth.logout",
  handler: async ({ ctx }) => {
    const { getSessionStore } = await import("@/server/auth/session-store");
    const { getSessionCookie, clearSessionCookie, clearCsrfCookie } =
      await import("@/server/auth/cookies");

    const token = getSessionCookie(ctx.cookies);
    if (token) {
      await getSessionStore().deleteByToken(token);
    }
    // Clear cookies unconditionally — logout is idempotent.
    clearSessionCookie(ctx.cookies);
    clearCsrfCookie(ctx.cookies);

    return { ok: true } as const;
  },
};
const logoutGate = defineServerFn(logoutGateOptions);
export const logout = createServerFn({ method: "POST" })
  .middleware([logoutGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// me — GET, auth: public → { user, session } | { user: null, session: null }
//
// A lightweight session probe used by the frontend on load. auth 'public' so an
// unauthenticated caller gets a 200 with a null user (not a 401). No CSRF, no
// audit (high-frequency). `ctx.user` / `ctx.session` are populated by
// resolveContext from the session cookie.
// ---------------------------------------------------------------------------

/** Me gate options (exported for the node-env test — see loginGateOptions). */
export const meGateOptions: ServerFnOptions<unknown, { user: unknown; session: unknown }> = {
  method: "GET",
  auth: "public",
  surface: "auth",
  action: "auth.me",
  handler: ({ ctx }) => {
    if (!ctx.user || !ctx.session) {
      return { user: null, session: null };
    }
    return { user: ctx.user, session: ctx.session };
  },
};
const meGate = defineServerFn(meGateOptions);
export const me = createServerFn({ method: "GET" }).middleware([meGate]).handler(serverFnNoop);
