import { createFileRoute } from "@tanstack/react-router";
import { AccountTokensPage } from "../../../../account/api-tokens-page.tsx";

export const Route = createFileRoute("/_app/settings/account/tokens")({
  component: AccountTokensPage,
});
