import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/features/Overview";

export const Route = createFileRoute("/_authenticated/overview")({ component: OverviewPage });
