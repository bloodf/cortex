import { createFileRoute } from "@tanstack/react-router";
import { AdminEnvPage } from "@/features/admin/EnvBrowser";

export const Route = createFileRoute("/_authenticated/admin/env-browser")({
  component: AdminEnvPage,
});
