import { createFileRoute } from "@tanstack/react-router";
import DockerSearchPage from "@/features/DockerSearch";

export const Route = createFileRoute("/_authenticated/docker-search")({
  component: DockerSearchPage,
});
