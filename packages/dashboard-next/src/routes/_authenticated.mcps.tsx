import { createFileRoute } from "@tanstack/react-router";
import McpsPage from "@/features/Mcps";

export const Route = createFileRoute("/_authenticated/mcps")({ component: McpsPage });
