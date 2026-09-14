import { createFileRoute } from "@tanstack/react-router";
import { StoragePage } from "@/features/Storage";

export const Route = createFileRoute("/_authenticated/storage")({ component: StoragePage });
