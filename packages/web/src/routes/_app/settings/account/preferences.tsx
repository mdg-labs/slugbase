import { createFileRoute } from "@tanstack/react-router";
import { AccountPreferencesPage } from "../../../../account/preferences-page.tsx";

export const Route = createFileRoute("/_app/settings/account/preferences")({
  component: AccountPreferencesPage,
});
