import { createFileRoute } from "@tanstack/react-router";
import { AdminServicesPage } from "@/features/admin/Services";

export const Route = createFileRoute("/_authenticated/admin/services")({
  component: AdminServicesPage,
});
