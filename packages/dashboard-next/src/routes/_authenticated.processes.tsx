import { createFileRoute } from "@tanstack/react-router";
import { ProcessesPage } from "@/features/Processes";

export const Route = createFileRoute("/_authenticated/processes")({ component: ProcessesPage });
