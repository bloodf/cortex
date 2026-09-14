import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route: renders child routes (index = list, /$name = detail) into the
// Outlet. Without this Outlet, /incus/$name could not mount and fell back to
// the list. The list itself lives in _authenticated.incus.index.tsx.
export const Route = createFileRoute("/_authenticated/incus")({
  component: () => <Outlet />,
});
