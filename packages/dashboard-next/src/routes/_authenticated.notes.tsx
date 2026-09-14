import { createFileRoute } from "@tanstack/react-router";
import { MdEditorPage } from "@/features/MdEditor";

export const Route = createFileRoute("/_authenticated/notes")({
  component: MdEditorPage,
});
