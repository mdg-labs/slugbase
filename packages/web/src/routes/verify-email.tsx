import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AuthPage } from "../auth/auth-page.tsx";
import { VerifyEmailForm } from "../auth/verify-email-form.tsx";
import { useConfig } from "../config/config-context.tsx";
import { isSetupRequired } from "../config/setup-state.ts";

function VerifyEmailPage(): ReactElement {
  const { t } = useTranslation();
  const { product } = useConfig();
  return (
    <AuthPage description={t("verifyEmail.description", { name: product.name })} productName={product.name} title={t("verifyEmail.title")}>
      <VerifyEmailForm />
    </AuthPage>
  );
}

export const Route = createFileRoute("/verify-email")({
  // The link is for whoever opens it, signed in or not: redeeming the token replaces the browser's session.
  // While the instance has no account there is nothing to verify: the visitor is sent to set it up.
  beforeLoad: ({ context }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: VerifyEmailPage,
});
