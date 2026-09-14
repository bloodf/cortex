import { createFileRoute } from "@tanstack/react-router";
import { NetworkPage } from "@/features/Network";

export const Route = createFileRoute("/_authenticated/network")({ component: NetworkPage });
