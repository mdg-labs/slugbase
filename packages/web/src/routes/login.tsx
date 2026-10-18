import { Separator } from "@slugbase/ui";
import { Banner } from "@slugbase/ui/patterns";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AuthPage } from "../auth/auth-page.tsx";
import { LoginForm } from "../auth/login-form.tsx";
import { safeNextPath } from "../auth/next-path.ts";
import { LOGIN_INTENT, OIDC_FAILED, oidcProvidersOf } from "../auth/oidc.ts";
import { ProviderButtons } from "../auth/provider-buttons.tsx";
import { sessionQuery } from "../auth/session.ts";
import { useConfig } from "../config/config-context.tsx";
import { isSetupRequired } from "../config/setup-state.ts";

function LoginPage(): ReactElement {
  const { t } = useTranslation();
  const config = useConfig();
  const { product } = config;
  const { next, error } = Route.useSearch();
  const providers = oidcProvidersOf(config);
  return (
    <AuthPage description={t("login.description", { name: product.name })} productName={product.name} title={t("login.title")}>
      <div className="flex flex-col gap-4">
        {error === OIDC_FAILED ? <Banner title={t("login.error.oidcFailed")} variant="error" /> : null}
        <LoginForm next={next} />
        {providers.length === 0 ? null : (
          <>
            <div className="flex items-center gap-3 text-muted-foreground text-sm">
              <Separator className="flex-1" />
              <span>{t("login.or")}</span>
              <Separator className="flex-1" />
            </div>
            <ProviderButtons
              intent={LOGIN_INTENT}
              label={(name) => t("login.provider", { name })}
              providers={providers}
              returnTo={safeNextPath(next)}
            />
          </>
        )}
        {config.signIn?.registration === true ? (
          <p className="text-center text-muted-foreground text-sm">
            <Link className="underline underline-offset-4" to="/register">
              {t("login.register")}
            </Link>
          </p>
        ) : null}
      </div>
    </AuthPage>
  );
}

export const Route = createFileRoute("/login")({
  // `error` is the code the OIDC callback redirects with; only that one is acted on, and it is never shown as given.
  validateSearch: (search: Record<string, unknown>): { next?: string; error?: string } => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  // A visitor who is signed in has nothing to do here. The session is asked afresh each time:
  // whatever the page last knew may be a session that has since ended. A check that cannot be
  // answered leaves the form in place; signing in reports what is wrong.
  // While the instance has no account there is nobody to sign in: the visitor is sent to set it up.
  beforeLoad: async ({ context, search }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
    const signedIn = await context.queryClient.query({ ...sessionQuery(context.api), staleTime: 0 }).then(
      () => true,
      () => false,
    );
    if (signedIn) {
      // A failed link or re-authentication started from the Security page comes back here with the same
      // error code; the signed-in member is taken to the page that can tell them.
      const failed = search.error === OIDC_FAILED;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect(
        failed ? { to: "/settings/account/security", search: { error: OIDC_FAILED }, replace: true } : { to: "/", replace: true },
      );
    }
  },
  component: LoginPage,
});
