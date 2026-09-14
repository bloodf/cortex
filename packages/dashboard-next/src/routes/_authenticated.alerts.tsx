import { createFileRoute } from "@tanstack/react-router";
import { AlertsPage } from "@/features/Alerts";

export const Route = createFileRoute("/_authenticated/alerts")({ component: AlertsPage });
