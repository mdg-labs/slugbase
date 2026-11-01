import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceAiPage } from "../../../../shell/workspace-ai-page.tsx";

export const Route = createFileRoute("/_app/settings/workspace/ai")({
  component: WorkspaceAiPage,
});
