import { createFileRoute } from "@tanstack/react-router";
import { AdminAlertsPage } from "@/features/admin/Alerts";

export const Route = createFileRoute("/_authenticated/admin/alerts")({
  component: AdminAlertsPage,
});
