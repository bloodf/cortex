import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "@/features/Approvals";

export const Route = createFileRoute("/_authenticated/approvals")({ component: ApprovalsPage });
