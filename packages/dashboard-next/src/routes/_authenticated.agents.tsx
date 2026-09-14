import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route: renders child routes into the Outlet. Children: index = the
// deployed-agent list (_authenticated.agents.index.tsx) and $slug/chat = chat
// with a built agent.
export const Route = createFileRoute("/_authenticated/agents")({
  component: () => <Outlet />,
});
