import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";
import { me as meFn } from "@/lib/api/auth.functions";
import { decideAdminAccess, type GuardUser } from "@/lib/auth/route-guards";

// The gate-middleware pattern (defineServerFn + serverFnNoop) makes TypeScript
// infer the server-fn return as `undefined`; recover the real shape here.
const callMe = meFn as unknown as (opts?: {
  data?: Record<string, never>;
}) => Promise<{ user: GuardUser }>;

export const Route = createFileRoute("/_authenticated/admin")({
  // Cookie-authoritative admin gate (mirrors _authenticated.tsx). The `me()`
  // RPC carries the session cookie on both SSR and client renders, so this is
  // SSR-safe. Server fns under /admin still enforce auth:'admin' independently;
  // this redirect is UX only. (Replaces a broken localStorage['cortex.auth']
  // check that bounced every user, admins included.)
  beforeLoad: async () => {
    let user: GuardUser = null;
    try {
      const res = await callMe({ data: {} });
      user = res.user;
    } catch {
      user = null;
    }
    const decision = decideAdminAccess(user);
    if (decision === "redirect-login") throw redirect({ to: "/login" });
    if (decision === "redirect-overview") throw redirect({ to: "/overview" });
  },
  component: () => <Outlet />,
});
