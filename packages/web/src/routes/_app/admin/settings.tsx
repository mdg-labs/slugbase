import { createFileRoute } from "@tanstack/react-router";
import { AdminSettingsPage } from "../../../shell/admin-settings-page.tsx";

export const Route = createFileRoute("/_app/admin/settings")({
  component: AdminSettingsPage,
});
