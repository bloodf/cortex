import { createFileRoute } from "@tanstack/react-router";
import IncusPage from "@/features/Incus";

export const Route = createFileRoute("/_authenticated/incus/")({
  component: IncusPage,
});
