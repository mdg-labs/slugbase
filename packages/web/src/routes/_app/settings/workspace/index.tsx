import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceGeneralPage } from "../../../../shell/workspace-general-page.tsx";

export const Route = createFileRoute("/_app/settings/workspace/")({
  component: WorkspaceGeneralPage,
});
