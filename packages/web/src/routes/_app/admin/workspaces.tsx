import { createFileRoute } from "@tanstack/react-router";
import { AdminWorkspacesPage } from "../../../shell/admin-workspaces-page.tsx";

export const Route = createFileRoute("/_app/admin/workspaces")({
  component: AdminWorkspacesPage,
});
