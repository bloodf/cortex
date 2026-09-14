/**
 * Pure, client-safe route-guard decisions.
 *
 * The route `beforeLoad` hooks are cookie-authoritative: they call the
 * `me()` server fn (which carries the session cookie on both SSR and client
 * renders) and pass the resulting user into these helpers. Keeping the
 * decision logic pure makes it unit-testable without a router/SSR harness.
 *
 * NOTE: this replaced a broken guard that read `localStorage["cortex.auth"]`
 * — a key nothing in the app ever writes — so the admin section evaluated as
 * "not admin" for everyone (admins included) and the landing page treated
 * every authenticated user as logged-out. Never reintroduce a localStorage
 * auth gate: the session lives in an HttpOnly cookie, not localStorage.
 */

/** The subset of the `me()` user we need to make a guard decision. */
export type GuardUser = { is_admin?: boolean } | null | undefined;

export type AdminDecision = "allow" | "redirect-overview" | "redirect-login";

/**
 * Decide access to `/admin/*`.
 * - no session       → send to /login
 * - session, !admin  → send to /overview (server fns still deny them; this is UX)
 * - session, admin   → allow
 */
export function decideAdminAccess(user: GuardUser): AdminDecision {
  if (!user) return "redirect-login";
  return user.is_admin === true ? "allow" : "redirect-overview";
}

export type LandingTarget = "/overview" | "/login";

/** Decide where the `/` landing route should send a visitor. */
export function decideLanding(user: GuardUser): LandingTarget {
  return user ? "/overview" : "/login";
}
