import { createFileRoute } from "@tanstack/react-router";
import { AccountDataPage } from "../../../../data/data-page.tsx";

export const Route = createFileRoute("/_app/settings/account/data")({
  component: AccountDataPage,
});
