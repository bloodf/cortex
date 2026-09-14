import { createFileRoute, redirect } from "@tanstack/react-router";
import { me as meFn } from "@/lib/api/auth.functions";
import { decideLanding, type GuardUser } from "@/lib/auth/route-guards";

const callMe = meFn as unknown as (opts?: {
  data?: Record<string, never>;
}) => Promise<{ user: GuardUser }>;

export const Route = createFileRoute("/")({
  // Cookie-authoritative landing redirect. The `me()` RPC carries the session
  // cookie (SSR + client), so an authenticated visitor lands on /overview and
  // everyone else on /login. (Replaces a localStorage['cortex.auth'] check that
  // is never written, which sent authenticated users to /login.)
  beforeLoad: async () => {
    let user: GuardUser = null;
    try {
      const res = await callMe({ data: {} });
      user = res.user;
    } catch {
      user = null;
    }
    throw redirect({ to: decideLanding(user) });
  },
  component: () => null,
});
