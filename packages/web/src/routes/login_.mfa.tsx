import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isSessionEnded } from "../api/client.ts";
import { AuthPage } from "../auth/auth-page.tsx";
import { isMfaRequired } from "../auth/mfa.ts";
import { MfaForm } from "../auth/mfa-form.tsx";
import { sessionQuery } from "../auth/session.ts";
import { useConfig } from "../config/config-context.tsx";
import { isSetupRequired } from "../config/setup-state.ts";

function LoginMfaPage(): ReactElement {
  const { t } = useTranslation();
  const { product } = useConfig();
  const { next } = Route.useSearch();
  return (
    <AuthPage description={t("loginMfa.description")} productName={product.name} title={t("loginMfa.title")}>
      <MfaForm next={next} />
    </AuthPage>
  );
}

export const Route = createFileRoute("/login_/mfa")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" ? { next: search.next } : {},
  // The page is for a visitor who has given the right password and still owes the code. The session is
  // asked afresh: a full one has nothing to do here, none at all means the sign-in has to start over,
  // and a check that cannot be answered leaves the form in place, where giving the code reports what is wrong.
  beforeLoad: async ({ context, search }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
    const state = await context.queryClient.query({ ...sessionQuery(context.api), staleTime: 0 }).then(
      () => "complete" as const,
      (error: unknown) => (isMfaRequired(error) ? ("pending" as const) : isSessionEnded(error) ? ("none" as const) : ("unknown" as const)),
    );
    if (state === "complete") {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/", replace: true });
    }
    if (state === "none") {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/login", search: search.next === undefined ? {} : { next: search.next }, replace: true });
    }
  },
  component: LoginMfaPage,
});
