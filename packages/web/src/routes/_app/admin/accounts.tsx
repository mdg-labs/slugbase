import { createFileRoute } from "@tanstack/react-router";
import { AdminAccountsPage } from "../../../shell/admin-accounts-page.tsx";

export const Route = createFileRoute("/_app/admin/accounts")({
  component: AdminAccountsPage,
});
