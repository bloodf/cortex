import { createFileRoute } from "@tanstack/react-router";
import { BackupsPage } from "@/features/Backups";

export const Route = createFileRoute("/_authenticated/backups")({ component: BackupsPage });
