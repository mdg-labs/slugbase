import { AuthCard } from "@slugbase/ui/patterns";
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { LoginForm } from "../auth/login-form.tsx";
import { sessionQuery } from "../auth/session.ts";
import { useConfig } from "../config/config-context.tsx";

function LoginPage(): ReactElement {
  const { t } = useTranslation();
  const { product } = useConfig();
  const { next } = Route.useSearch();
  return (
    <AuthCard description={t("login.description", { name: product.name })} productName={product.name} title={t("login.title")}>
      <LoginForm next={next} />
    </AuthCard>
  );
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" ? { next: search.next } : {},
  // A visitor who is signed in has nothing to do here. The session is asked afresh each time:
  // whatever the page last knew may be a session that has since ended. A check that cannot be
  // answered leaves the form in place; signing in reports what is wrong.
  beforeLoad: async ({ context }) => {
    const signedIn = await context.queryClient.query({ ...sessionQuery(context.api), staleTime: 0 }).then(
      () => true,
      () => false,
    );
    if (signedIn) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/", replace: true });
    }
  },
  component: LoginPage,
});
