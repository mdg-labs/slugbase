import { Button } from "@slugbase/ui";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AuthPage } from "../auth/auth-page.tsx";
import { CheckEmail } from "../auth/check-email.tsx";
import { RegisterForm } from "../auth/register-form.tsx";
import { sessionQuery } from "../auth/session.ts";
import { useConfig } from "../config/config-context.tsx";
import { isSetupRequired } from "../config/setup-state.ts";

function RegisterPage(): ReactElement {
  const { t } = useTranslation();
  const { product, signIn, features } = useConfig();
  const [registered, setRegistered] = useState<string | undefined>(undefined);
  // The server can close registration after the configuration was read; its answer closes the page too.
  const [closedByServer, setClosedByServer] = useState(false);
  if (signIn?.registration !== true || closedByServer) {
    return (
      <AuthPage description={t("register.closed.description")} productName={product.name} title={t("register.closed.title")}>
        <Button render={<Link to="/login" />} variant="outline">
          {t("register.closed.signIn")}
        </Button>
      </AuthPage>
    );
  }
  if (registered !== undefined) {
    // Without mail nothing was sent, so there is no link to wait for: the account can sign in at once (doc 02 section 2.2).
    return features.mail ? (
      <AuthPage productName={product.name} title={t("register.checkEmail.title")}>
        <CheckEmail email={registered} />
      </AuthPage>
    ) : (
      <AuthPage description={t("register.ready.description")} productName={product.name} title={t("register.ready.title")}>
        <Button render={<Link to="/login" />}>{t("register.ready.signIn")}</Button>
      </AuthPage>
    );
  }
  return (
    <AuthPage description={t("register.description", { name: product.name })} productName={product.name} title={t("register.title")}>
      <RegisterForm
        onClosed={() => {
          setClosedByServer(true);
        }}
        onRegistered={setRegistered}
      />
    </AuthPage>
  );
}

export const Route = createFileRoute("/register")({
  // A visitor who is signed in has nothing to register; the session is asked afresh, as for the sign-in page.
  // While the instance has no account there is nobody to register next to: the visitor is sent to set it up.
  beforeLoad: async ({ context }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
    const signedIn = await context.queryClient.query({ ...sessionQuery(context.api), staleTime: 0 }).then(
      () => true,
      () => false,
    );
    if (signedIn) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/", replace: true });
    }
  },
  component: RegisterPage,
});
