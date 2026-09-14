import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/app/AppShell";
import { me as meFn } from "@/lib/api/auth.functions";

// The gate-middleware pattern (defineServerFn + serverFnNoop) makes TypeScript
// infer the server-fn return as `undefined`; recover the real shape here.
interface MeResult {
  user: unknown;
  session: unknown;
}
const callMe = meFn as unknown as (opts?: { data?: Record<string, never> }) => Promise<MeResult>;

export const Route = createFileRoute("/_authenticated")({
  // Real session check (cookie-authoritative). `me` is auth:'public' so an
  // unauthenticated caller gets `{ user: null }` (not a throw); we redirect to
  // /login when there is no user. Runs on both server and client renders; the
  // RPC carries the session cookie either way, so it is SSR-safe.
  beforeLoad: async ({ location }) => {
    let user: unknown = null;
    try {
      const res = await callMe({ data: {} });
      user = res.user;
    } catch {
      user = null;
    }
    if (!user) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
