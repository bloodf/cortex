import { createFileRoute } from "@tanstack/react-router";
import { DockerPage } from "@/features/Docker";

export const Route = createFileRoute("/_authenticated/docker/")({
  component: DockerPage,
});
