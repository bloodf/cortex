import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route: renders child routes (index = list, /$id = detail) into the
// Outlet. Without this Outlet, /docker/$id could not mount and fell back to the
// list. The list itself lives in _authenticated.docker.index.tsx.
export const Route = createFileRoute("/_authenticated/docker")({
  component: () => <Outlet />,
});
