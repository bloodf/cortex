import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route: renders child routes (index = list, /$unit = detail) into the
// Outlet. Without this Outlet, /systemd/$unit could not mount and fell back to
// the list. The list itself lives in _authenticated.systemd.index.tsx.
export const Route = createFileRoute("/_authenticated/systemd")({
  component: () => <Outlet />,
});
