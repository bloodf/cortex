import { createFileRoute } from "@tanstack/react-router";
import { SystemdPage } from "@/features/Systemd";

export const Route = createFileRoute("/_authenticated/systemd/")({
  component: SystemdPage,
});
