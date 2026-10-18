import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AuthPage } from "../auth/auth-page.tsx";
import { EmailChangeResult, type EmailChangeLink } from "../auth/email-change-result.tsx";
import { useConfig } from "../config/config-context.tsx";
import { isSetupRequired } from "../config/setup-state.ts";

const LINK: EmailChangeLink = "confirm";

function EmailChangeConfirmPage(): ReactElement {
  const { t } = useTranslation();
  const { product } = useConfig();
  return (
    <AuthPage description={t("emailChange.confirm.description")} productName={product.name} title={t("emailChange.confirm.title")}>
      <EmailChangeResult link={LINK} />
    </AuthPage>
  );
}

export const Route = createFileRoute("/email-change/confirm")({
  // The link is for whoever opens it, signed in or not.
  // While the instance has no account there is nothing to change: the visitor is sent to set it up.
  beforeLoad: ({ context }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: EmailChangeConfirmPage,
});
