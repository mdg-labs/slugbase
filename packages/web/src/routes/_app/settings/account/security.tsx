import { createFileRoute } from "@tanstack/react-router";
import { AccountSecurityPage } from "../../../../account/security-page.tsx";

export const Route = createFileRoute("/_app/settings/account/security")({
  component: AccountSecurityPage,
});
