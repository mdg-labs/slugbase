import { useTranslate } from "@tolgee/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { getSessionUser } from "../../lib/session-client.js";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

/** Redirect already-authenticated users away from the login page. */
export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (user) {
    return redirect(user.emailVerified ? "/" : "/verify-email");
  }
  const url = new URL(request.url);
  const passwordReset = url.searchParams.get("reset") === "success";
  return { passwordReset };
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
  const { passwordReset } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showPassword, setShowPassword] = useState(false);

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <div className="flex min-h-screen bg-canvas font-sans">
      {/* Brand rail — hidden on small screens */}
      <aside
        className="hidden lg:flex w-[400px] shrink-0 flex-col justify-between border-r border-[color:var(--border)] bg-base p-sp-8"
        aria-hidden="true"
      >
        <div className="flex items-center gap-sp-3">
          <img
            src="/slugbase_icon.svg"
            alt=""
            width={28}
            height={28}
            className="shrink-0"
          />
          <span
            className="text-fg font-semibold"
            style={{ fontSize: "var(--text-h3)", lineHeight: "var(--lh-h3)" }}
          >
            SlugBase
          </span>
        </div>

        <div className="flex flex-col gap-sp-7">
          <div className="flex flex-col gap-sp-4">
            <h1
              className="text-fg font-semibold"
              style={{
                fontSize: "var(--text-h2)",
                lineHeight: "var(--lh-h2)",
              }}
            >
              {t("auth.brand.headline")}
            </h1>
            <p
              className="text-fg-muted"
              style={{
                fontSize: "var(--text-body-lg)",
                lineHeight: "var(--lh-body-lg)",
              }}
            >
              {t("auth.brand.subline")}
            </p>
          </div>

          <div className="flex flex-col gap-sp-3">
            <SlugRow
              src="go.slugbase.app/react19"
              dst="react.dev/blog"
              opacity={1}
            />
            <SlugRow
              src="go.slugbase.app/ddia"
              dst="dataintensive.net"
              opacity={0.5}
            />
            <SlugRow
              src="go.slugbase.app/rustperf"
              dst="nnethercote.github.io"
              opacity={0.25}
            />
          </div>
        </div>

        <p
          className="text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("auth.brand.footer")}
        </p>
      </aside>

      {/* Auth pane */}
      <div className="flex flex-1 items-center justify-center p-sp-8">
        <div className="w-full max-w-[360px]">
          {/* Card mark */}
          <div className="mb-sp-7 flex items-center gap-sp-3">
            <img
              src="/slugbase_icon.svg"
              alt=""
              width={24}
              height={24}
              className="shrink-0"
            />
            <span
              className="text-fg font-semibold"
              style={{ fontSize: "var(--text-h3)", lineHeight: "var(--lh-h3)" }}
            >
              SlugBase
            </span>
          </div>

          {/* Heading */}
          <div className="mb-sp-7">
            <h2
              className="text-fg font-semibold"
              style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
            >
              {t("auth.login.title")}
            </h2>
            <p
              className="mt-sp-2 text-fg-muted"
              style={{
                fontSize: "var(--text-body)",
                lineHeight: "var(--lh-body)",
              }}
            >
              {t("auth.login.subtitle")}
            </p>
          </div>

          <Form method="post" className="flex flex-col gap-sp-5" noValidate>
            {/* Password reset success banner */}
            {passwordReset && (
              <div
                role="status"
                className="flex items-start gap-sp-3 rounded-md border border-[color:var(--success-subtle)] bg-[color:var(--success-subtle)] px-sp-4 py-sp-3"
              >
                <p
                  className="text-success-text"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                >
                  {t("auth.login.reset_success")}
                </p>
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-sp-3 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3"
              >
                <p
                  className="text-danger-text"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                >
                  {t(error)}
                </p>
              </div>
            )}

            {/* Email field */}
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="email"
                className="font-medium text-fg-muted"
                style={{
                  fontSize: "var(--text-small)",
                  lineHeight: "var(--lh-small)",
                }}
              >
                {t("auth.login.email_label")}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder={t("auth.login.email_placeholder")}
                className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                style={{
                  fontSize: "var(--text-body)",
                  lineHeight: "var(--lh-body)",
                }}
              />
            </div>

            {/* Password field */}
            <div className="flex flex-col gap-sp-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="font-medium text-fg-muted"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                >
                  {t("auth.login.password_label")}
                </label>
                <a
                  href="/forgot-password"
                  className="text-accent-text hover:underline"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                >
                  {t("auth.login.password_forgot_link")}
                </a>
              </div>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  placeholder={t("auth.password.mask_placeholder")}
                  className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 pr-10 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                  style={{
                    fontSize: "var(--text-body)",
                    lineHeight: "var(--lh-body)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => { setShowPassword((v) => !v); }}
                  aria-label={t(
                    showPassword
                      ? "auth.login.password_hide"
                      : "auth.login.password_show",
                  )}
                  className="absolute inset-y-0 right-0 flex items-center px-sp-4 text-fg-subtle hover:text-fg"
                >
                  {showPassword ? (
                    <EyeOffIcon />
                  ) : (
                    <EyeIcon />
                  )}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-sp-2 w-full rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                fontSize: "var(--text-body)",
                lineHeight: "var(--lh-body)",
              }}
            >
              {isSubmitting
                ? t("auth.login.submit_loading")
                : t("auth.login.submit")}
            </button>
          </Form>

          <p
            className="mt-sp-6 text-center text-fg-subtle"
            style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
          >
            {t("auth.login.no_account_prompt")}{" "}
            <a href="/register" className="text-accent-text hover:underline">
              {t("auth.login.no_account_link")}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function SlugRow({
  src,
  dst,
  opacity,
}: {
  src: string;
  dst: string;
  opacity: number;
}) {
  return (
    <div
      className="flex items-center gap-sp-3"
      style={{ opacity, fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)", lineHeight: "var(--lh-mono)" }}
    >
      <span className="text-accent-text">{src}</span>
      <span className="text-fg-subtle">→</span>
      <span className="text-fg-muted">{dst}</span>
    </div>
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
