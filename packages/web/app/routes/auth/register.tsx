import { useTranslation } from "react-i18next";
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
  SsoSection,
  UserFieldIcon,
} from "./AuthShell.js";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

/** Reads session cookie from an API response (undici getSetCookie or fetch get). */
export function readApiSessionCookie(res: Response): string | null {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie()[0] ?? null;
  }
  return res.headers.get("set-cookie");
}

/** 0 = empty, 1 = very_weak, 2 = weak, 3 = fair, 4 = strong */
function calcPasswordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  if (password.length < 8) return 1;

  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;

  if (classes <= 1) return 2;
  if (classes === 2 && password.length < 12) return 2;
  if (classes >= 3 && password.length < 12) return 3;
  if (classes === 2) return 3;
  return 4;
}

const STRENGTH_KEYS = [
  null,
  "register.password_strength.very_weak",
  "register.password_strength.weak",
  "register.password_strength.fair",
  "register.password_strength.strong",
] as const;

const STRENGTH_COLORS = ["", "bg-danger", "bg-warning", "bg-warning", "bg-success"] as const;
const STRENGTH_TEXT_COLORS = [
  "",
  "text-danger-text",
  "text-warning-text",
  "text-warning-text",
  "text-success-text",
] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (user) {
    return redirect(user.emailVerified ? "/" : "/verify-email");
  }

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
    // graceful degradation
  }

  return { oidcProviders };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const rawName = formData.get("name");
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");

  const name = typeof rawName === "string" ? rawName.trim() : "";
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "register.error_invalid_email" };
  }
  if (password.length < 8) {
    return { error: "register.error_password_too_short" };
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
  } catch {
    return { error: "register.error_generic" };
  }

  if (res.status === 403) {
    return { error: "register.error_disabled" };
  }

  if (res.status === 409) {
    return { error: "register.error_email_taken" };
  }

  if (!res.ok) {
    return { error: "register.error_generic" };
  }

  const payload = (await res.json()) as
    | { userId: string; emailVerificationRequired?: boolean }
    | { emailVerificationRequired: true };

  const setCookie = readApiSessionCookie(res);

  if ("emailVerificationRequired" in payload && payload.emailVerificationRequired) {
    const redirectResponse = redirect("/verify-email");
    if (setCookie !== null) {
      redirectResponse.headers.set("Set-Cookie", setCookie);
    }
    return redirectResponse;
  }

  const redirectResponse = redirect("/");
  if (setCookie !== null) {
    redirectResponse.headers.set("Set-Cookie", setCookie);
  }
  return redirectResponse;
}

export default function RegisterRoute() {
  const { t } = useTranslation();
  const { oidcProviders } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");

  const strength = calcPasswordStrength(password);

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;

  if (error === "register.error_disabled") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center text-center" style={{ gap: "var(--sp-6)" }}>
          <div
            role="status"
            className="w-full rounded-lg border border-[color:var(--border)] bg-raised"
            style={{ padding: "var(--sp-8)" }}
          >
            <p
              className="text-fg-muted"
              style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
            >
              {t("register.error_disabled")}
            </p>
            <a
              href="/login"
              className="inline-block text-accent-text hover:underline"
              style={{ marginTop: "var(--sp-5)", fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
            >
              {t("register.sign_in_link")}
            </a>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHeading title={t("register.title")} subtitle={t("register.subtitle")} />

      <Form method="post" className="flex flex-col" noValidate style={{ gap: "var(--sp-6)" }} data-testid="register-form">
        {error && <ErrorBanner message={t(error)} />}

        {/* Name */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="name"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("register.name_label")}
          </label>
          <AuthInput
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            placeholder={t("register.name_placeholder")}
            leadingIcon={<UserFieldIcon />}
            data-testid="register-name-input"
          />
        </div>

        {/* Email */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="email"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("register.email_label")}
          </label>
          <AuthInput
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            placeholder={t("register.email_placeholder")}
            leadingIcon={<MailFieldIcon />}
            data-testid="register-email-input"
          />
        </div>

        {/* Password + strength meter (always visible) */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="password"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("register.password_label")}
          </label>
          <AuthInput
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            placeholder={t("auth.password.mask_placeholder")}
            value={password}
            onChange={(e) => { setPassword(e.target.value); }}
            leadingIcon={<LockFieldIcon />}
            trailingSlot={
              <button
                type="button"
                onClick={() => { setShowPassword((v) => !v); }}
                aria-label={t(
                  showPassword ? "register.password_hide" : "register.password_show",
                )}
                className="flex items-center text-fg-subtle hover:text-fg px-sp-4"
                style={{ height: "42px" }}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            }
            data-testid="register-password-input"
          />

          {/* Strength meter - always visible once any input exists */}
          <div className="flex flex-col" style={{ gap: "var(--sp-3)" }} aria-live="polite">
            <div
              className="grid gap-sp-3"
              style={{ gridTemplateColumns: "repeat(4,1fr)" }}
              role="presentation"
            >
              {([1, 2, 3, 4] as const).map((level) => (
                <div
                  key={level}
                  className={`rounded-full transition-colors duration-[var(--duration-fast)] ${
                    strength >= level ? STRENGTH_COLORS[strength] : "bg-[color:var(--border)]"
                  }`}
                  style={{ height: "4px" }}
                />
              ))}
            </div>
            <div
              className="flex items-center justify-between"
              style={{ fontSize: "var(--text-small)" }}
            >
              <span
                className={
                  strength > 0 ? STRENGTH_TEXT_COLORS[strength] : "text-fg-subtle"
                }
                style={{ fontWeight: "var(--weight-medium)" }}
              >
                {strength > 0
                  ? t(STRENGTH_KEYS[strength] ?? "register.password_strength.weak")
                  : "\u00a0"}
              </span>
              <span
                className="text-fg-subtle"
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}
              >
                {t("register.password_requirements")}
              </span>
            </div>
          </div>
        </div>

        <div data-testid="register-submit-btn">
          <AuthButton isSubmitting={isSubmitting} style={{ marginTop: "var(--sp-2)" }}>
            {isSubmitting ? t("register.submit_loading") : t("register.submit")}
          </AuthButton>
        </div>

        <SsoSection providers={oidcProviders} mode="register" t={t} />
      </Form>

      <p
        className="text-center text-fg-subtle"
        style={{ marginTop: "var(--sp-8)", fontSize: "var(--text-body)" }}
      >
        {t("register.sign_in_prompt")}{" "}
        <a href="/login" className="text-accent-text font-medium hover:underline">
          {t("register.sign_in_link")}
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
