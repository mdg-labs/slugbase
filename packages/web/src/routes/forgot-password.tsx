import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AuthPage } from "../auth/auth-page.tsx";
import { ForgotPasswordForm } from "../auth/forgot-password-form.tsx";
import { useConfig } from "../config/config-context.tsx";
import { isSetupRequired } from "../config/setup-state.ts";

function ForgotPasswordPage(): ReactElement {
  const { t } = useTranslation();
  const { product } = useConfig();
  return (
    <AuthPage description={t("forgotPassword.description")} productName={product.name} title={t("forgotPassword.title")}>
      <ForgotPasswordForm />
    </AuthPage>
  );
}

export const Route = createFileRoute("/forgot-password")({
  // The page is for a visitor without a session and asks the server nothing that needs one: a session probe here
  // would be answered with 401, which the session-expiry handler takes for an ended session on a page it does not
  // list as anonymous.
  // While the instance has no account there is nothing to recover: the visitor is sent to set it up.
  beforeLoad: ({ context }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: ForgotPasswordPage,
});
