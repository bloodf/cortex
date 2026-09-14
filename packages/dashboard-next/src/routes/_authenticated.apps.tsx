import { createFileRoute } from "@tanstack/react-router";
import AppsPage from "@/features/Apps";

export const Route = createFileRoute("/_authenticated/apps")({ component: AppsPage });
