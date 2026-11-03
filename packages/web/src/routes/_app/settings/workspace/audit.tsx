import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "../../../../audit/audit-page.tsx";

export const Route = createFileRoute("/_app/settings/workspace/audit")({
  component: AuditPage,
});
