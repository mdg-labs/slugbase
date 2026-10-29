import { createFileRoute } from "@tanstack/react-router";
import { TeamsPage } from "../../../../teams/teams-page.tsx";

export const Route = createFileRoute("/_app/settings/workspace/teams")({
  component: TeamsPage,
});
