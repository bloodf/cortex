import { createFileRoute } from "@tanstack/react-router";
import { SchedulerPage } from "@/features/Scheduler";

export const Route = createFileRoute("/_authenticated/scheduler")({ component: SchedulerPage });
