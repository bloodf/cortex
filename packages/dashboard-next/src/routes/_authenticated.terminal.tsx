import { createFileRoute } from "@tanstack/react-router";
import { TerminalPage } from "@/features/Terminal";

export const Route = createFileRoute("/_authenticated/terminal")({ component: TerminalPage });
