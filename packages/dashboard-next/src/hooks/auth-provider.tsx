import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { User as ContractUser } from "@cortexos/contracts/entities";
import { login as loginFn, logout as logoutFn, me as meFn } from "@/lib/api/auth.functions";
import { AuthContext, type AuthUser } from "./auth-context";

/** Request header the server double-submits the CSRF cookie against. */
const CSRF_HEADER = "x-csrf-token";

/** Read the JS-readable CSRF cookie so mutations can echo it (double-submit). */
function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;)\s*cortexos_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Map a contract User → the shell's AuthUser shape. */
function toAuthUser(u: ContractUser): AuthUser {
  return { username: u.username, is_admin: u.isAdmin };
}

// The gate-middleware pattern (defineServerFn + serverFnNoop) makes TypeScript
// infer the server-fn return as `undefined`; the real payload is carried by the
// gate at runtime. Recover the typed call shapes at this single boundary.
interface LoginResult {
  user: ContractUser | null;
  session: unknown;
}
interface MeResult {
  user: ContractUser | null;
  session: unknown;
}
const callLogin = loginFn as unknown as (opts: {
  data: { username: string; password: string };
}) => Promise<LoginResult>;
const callLogout = logoutFn as unknown as (opts: {
  headers?: Record<string, string>;
}) => Promise<{ ok: true }>;
const callMe = meFn as unknown as (opts?: { data?: Record<string, never> }) => Promise<MeResult>;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from the live session on mount (handles reload without re-login).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callMe({ data: {} });
        if (!cancelled) setUser(res.user ? toAuthUser(res.user) : null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    // login is auth:'public' — the server skips CSRF (pre-session) and sets the
    // session + CSRF cookies on success. Cookie is authoritative; mirror the
    // returned user into React state for the shell.
    const res = await callLogin({ data: { username, password } });
    setUser(res.user ? toAuthUser(res.user) : null);
  }, []);

  const logout = useCallback(async () => {
    // logout is auth:'any' — a mutation; echo the session-bound CSRF cookie in
    // the x-csrf-token header (double-submit). Idempotent; clear state regardless.
    const csrf = readCsrfCookie();
    try {
      await callLogout(csrf ? { headers: { [CSRF_HEADER]: csrf } } : {});
    } catch {
      /* clear local state even if the network call fails */
    }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}
