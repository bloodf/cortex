import { createFileRoute } from "@tanstack/react-router";
import { AdminBadgesPage } from "@/features/admin/Badges";

export const Route = createFileRoute("/_authenticated/admin/badges")({
  component: AdminBadgesPage,
});
