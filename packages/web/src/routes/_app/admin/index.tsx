import { createFileRoute } from "@tanstack/react-router";
import { AdminOverviewPage } from "../../../shell/admin-overview-page.tsx";

export const Route = createFileRoute("/_app/admin/")({
  component: AdminOverviewPage,
});
