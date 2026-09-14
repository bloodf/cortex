import { createFileRoute } from "@tanstack/react-router";
import { HealthcheckPage } from "@/features/Healthcheck";

export const Route = createFileRoute("/_authenticated/healthcheck")({ component: HealthcheckPage });
