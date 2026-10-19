import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceMembersPage } from "../../../../shell/workspace-members-page.tsx";

export const Route = createFileRoute("/_app/settings/workspace/members")({
  component: WorkspaceMembersPage,
});
