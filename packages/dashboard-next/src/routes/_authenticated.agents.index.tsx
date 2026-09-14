import { createFileRoute } from "@tanstack/react-router";
import AgentsPage from "@/features/Agents";

export const Route = createFileRoute("/_authenticated/agents/")({
  component: AgentsPage,
});
