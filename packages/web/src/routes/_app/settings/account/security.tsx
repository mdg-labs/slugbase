import { createFileRoute } from "@tanstack/react-router";
import { OIDC_FAILED } from "../../../../auth/oidc.ts";
import { AccountSecurityPage } from "../../../../account/security-page.tsx";

export const Route = createFileRoute("/_app/settings/account/security")({
  // `error` is the code the OIDC callback redirects with after a failed link or re-authentication; only that one is acted on.
  validateSearch: (search: Record<string, unknown>): { error?: "oidc_failed" } =>
    search.error === OIDC_FAILED ? { error: OIDC_FAILED } : {},
  component: AccountSecurityPage,
});
