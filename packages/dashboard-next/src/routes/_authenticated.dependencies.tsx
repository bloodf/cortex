import { createFileRoute } from "@tanstack/react-router";
import DependenciesPage from "@/features/Dependencies";

export const Route = createFileRoute("/_authenticated/dependencies")({
  component: DependenciesPage,
});
