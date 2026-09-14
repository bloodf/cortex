import { createFileRoute } from "@tanstack/react-router";
import { AdminProjectsPage } from "@/features/admin/Projects";

export const Route = createFileRoute("/_authenticated/admin/projects")({
  component: AdminProjectsPage,
});
