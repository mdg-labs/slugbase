import { useTranslate } from "@tolgee/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { getSessionUser } from "../../lib/session-client.js";
import {
  AuthButton,
  AuthHeading,
  AuthInput,
  AuthShell,
  ErrorBanner,
  LockFieldIcon,
  MailFieldIcon,
  type OidcProviderItem,
  SuccessBanner,
  SsoSection,
} from "./AuthShell.js";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

/** Redirect already-authenticated users away from the login page. */
export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (user) {
    return redirect(user.emailVerified ? "/" : "/verify-email");
  }
  const url = new URL(request.url);
  const passwordReset = url.searchParams.get("reset") === "success";

  let oidcProviders: OidcProviderItem[] = [];
  try {
    const res = await fetch(`${API_BASE_URL()}/auth/oidc/providers`);
    if (res.ok) {
      const data = (await res.json()) as { providers?: OidcProviderItem[] };
      oidcProviders = (data.providers ?? []).filter(
        (p): p is OidcProviderItem => typeof p.id === "string" && typeof p.name === "string",
      );
    }
  } catch {
    // public provider listing is optional — degrade gracefully
  }

  return { passwordReset, oidcProviders };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  if (!email || !password) {
    return { error: "auth.login.error_invalid" as const };
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { error: "auth.login.error_generic" as const };
  }

  if (res.status === 401) {
    return { error: "auth.login.error_invalid" as const };
  }

  if (!res.ok) {
    return { error: "auth.login.error_generic" as const };
  }

  const data = (await res.json()) as
    | { userId: string; emailVerificationRequired?: true }
    | { mfaRequired: true };

  const destination =
    "mfaRequired" in data
      ? "/mfa"
      : "emailVerificationRequired" in data && data.emailVerificationRequired
        ? "/verify-email"
        : "/";
  const redirectResponse = redirect(destination);

  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) {
    redirectResponse.headers.set("Set-Cookie", setCookie);
  }

  return redirectResponse;
}

export default function LoginRoute() {
  const { t } = useTranslate();
  const { passwordReset, oidcProviders } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showPassword, setShowPassword] = useState(false);

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <AuthShell>
      <AuthHeading title={t("auth.login.title")} />

      <Form method="post" className="flex flex-col" noValidate style={{ gap: "var(--sp-6)" }}>
        {passwordReset && <SuccessBanner message={t("auth.login.reset_success")} />}
        {error && <ErrorBanner message={t(error)} />}

        {/* Email */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="email"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("auth.login.email_label")}
          </label>
          <AuthInput
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            placeholder={t("auth.login.email_placeholder")}
            leadingIcon={<MailFieldIcon />}
          />
        </div>

        {/* Password */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <div
            className="flex items-baseline justify-between"
            style={{ gap: "var(--sp-4)" }}
          >
            <label
              htmlFor="password"
              className="font-medium text-fg-muted"
              style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
            >
              {t("auth.login.password_label")}
            </label>
            <a
              href="/forgot-password"
              className="text-accent-text hover:underline"
              style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
            >
              {t("auth.login.password_forgot_link")}
            </a>
          </div>
          <AuthInput
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            placeholder={t("auth.password.mask_placeholder")}
            leadingIcon={<LockFieldIcon />}
            trailingSlot={
              <button
                type="button"
                onClick={() => { setShowPassword((v) => !v); }}
                aria-label={t(
                  showPassword ? "auth.login.password_hide" : "auth.login.password_show",
                )}
                className="flex items-center text-fg-subtle hover:text-fg px-sp-4"
                style={{ height: "42px" }}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            }
          />
        </div>

        <AuthButton isSubmitting={isSubmitting} style={{ marginTop: "var(--sp-2)" }}>
          {isSubmitting ? t("auth.login.submit_loading") : t("auth.login.submit")}
        </AuthButton>

        <SsoSection providers={oidcProviders} mode="login" t={t} />
      </Form>

      <p
        className="text-center text-fg-subtle"
        style={{ marginTop: "var(--sp-8)", fontSize: "var(--text-body)" }}
      >
        {t("auth.login.no_account_prompt")}{" "}
        <a href="/register" className="text-accent-text font-medium hover:underline">
          {t("auth.login.no_account_link")}
        </a>
      </p>
    </AuthShell>
  );
}

function EyeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}
