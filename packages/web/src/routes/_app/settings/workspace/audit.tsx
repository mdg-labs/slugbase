import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "../../../../audit/audit-page.tsx";
import { validateAuditSearch } from "../../../../audit/audit-search.ts";

export const Route = createFileRoute("/_app/settings/workspace/audit")({
  // The filters of the log live in the address (doc 03 section 3.1).
  validateSearch: validateAuditSearch,
  component: AuditPage,
});
