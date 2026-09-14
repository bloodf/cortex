import { createFileRoute } from "@tanstack/react-router";
import { MailGuardianPage } from "@/features/MailGuardian";

export const Route = createFileRoute("/_authenticated/mail-guardian")({
  component: MailGuardianPage,
});
