import { createFileRoute } from "@tanstack/react-router";
import { AccountProfilePage } from "../../../../account/profile-page.tsx";

export const Route = createFileRoute("/_app/settings/account/")({
  component: AccountProfilePage,
});
