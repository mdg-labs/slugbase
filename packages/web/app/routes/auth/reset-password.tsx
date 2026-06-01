import { useTranslate } from "@tolgee/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { AuthShell, LockFieldIcon } from "./AuthShell.js";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

/** Password strength scoring — mirrors the design prototype (AuthKit.jsx). */
function scorePassword(value: string): 0 | 1 | 2 | 3 | 4 {
  if (!value) return 0;
  let s = 0;
  if (value.length >= 8) s++;
  if (value.length >= 12) s++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) s++;
  if (/\d/.test(value)) s++;
  if (/[^A-Za-z0-9]/.test(value)) s++;
  return Math.min(4, s) as 0 | 1 | 2 | 3 | 4;
}

/** Extract the reset token from the query string. */
export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  return { token };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();

  const rawToken = formData.get("token");
  const rawNew = formData.get("newPassword");
  const rawConfirm = formData.get("confirmPassword");

  const token = typeof rawToken === "string" ? rawToken : "";
  const newPassword = typeof rawNew === "string" ? rawNew : "";
  const confirmPassword = typeof rawConfirm === "string" ? rawConfirm : "";

  if (!token) {
    return { error: "password_reset.set.error_missing_token" as const };
  }

  if (newPassword !== confirmPassword) {
    return { error: "password_reset.set.error_passwords_mismatch" as const };
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });
  } catch {
    return { error: "password_reset.set.error_generic" as const };
  }

  if (res.status === 422) {
    return { error: "password_reset.set.error_token_invalid" as const };
  }

  if (!res.ok) {
    return { error: "password_reset.set.error_generic" as const };
  }

  return redirect("/login?reset=success");
}

export default function ResetPasswordRoute() {
  const { t } = useTranslate();
  const { token } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;

  const score = scorePassword(newPassword);
  const passwordsMatch =
    newPassword.length > 0 && confirmPassword.length > 0 && newPassword === confirmPassword;
  const passwordsMismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = passwordsMatch && newPassword.length >= 12;

  return (
    <AuthShell>
      {!token ? (
        <MissingTokenState t={t} />
      ) : (
        <>
          <div style={{ marginBottom: "var(--sp-8)" }}>
            <h2
              className="text-fg"
              style={{
                margin: "0 0 var(--sp-4)",
                fontWeight: "var(--weight-semi)",
                fontSize: "var(--text-h1)",
                lineHeight: "var(--lh-h1)",
                letterSpacing: "var(--track-tight)",
              }}
            >
              {t("password_reset.set.title")}
            </h2>
            <p
              className="text-fg-muted"
              style={{ margin: 0, fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
            >
              {t("password_reset.set.subtitle")}
            </p>
          </div>

          <Form method="post" className="flex flex-col" noValidate style={{ gap: "var(--sp-6)" }}>
            {error && (
              <div
                role="alert"
                className="flex items-start rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3"
                style={{ gap: "var(--sp-3)" }}
              >
                <p
                  className="text-danger-text"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t(error)}
                </p>
              </div>
            )}

            <input type="hidden" name="token" value={token} />

            {/* New password */}
            <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
              <label
                htmlFor="newPassword"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
              >
                {t("password_reset.set.new_password_label")}
              </label>
              <div className="relative">
                <span
                  className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
                  style={{ paddingLeft: "var(--sp-4)" }}
                >
                  <LockFieldIcon />
                </span>
                <input
                  id="newPassword"
                  name="newPassword"
                  type={showNew ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder={t("password_reset.set.new_password_placeholder")}
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); }}
                  className="w-full rounded-md border border-[color:var(--border)] bg-raised text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                  style={{
                    height: "42px",
                    paddingLeft: "calc(var(--sp-4) + 16px + var(--sp-3))",
                    paddingRight: "2.5rem",
                    fontSize: "var(--text-body-lg)",
                    lineHeight: "var(--lh-body-lg)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => { setShowNew((v) => !v); }}
                  aria-label={t(showNew ? "password_reset.set.password_hide" : "password_reset.set.password_show")}
                  className="absolute inset-y-0 right-0 flex items-center px-sp-4 text-fg-subtle hover:text-fg"
                >
                  {showNew ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              <PasswordStrength score={score} value={newPassword} t={t} />
            </div>

            {/* Confirm password */}
            <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
              <label
                htmlFor="confirmPassword"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
              >
                {t("password_reset.set.confirm_password_label")}
              </label>
              <div className="relative">
                <span
                  className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
                  style={{ paddingLeft: "var(--sp-4)" }}
                >
                  <LockFieldIcon />
                </span>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder={t("password_reset.set.confirm_password_placeholder")}
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); }}
                  className="w-full rounded-md border border-[color:var(--border)] bg-raised text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                  style={{
                    height: "42px",
                    paddingLeft: "calc(var(--sp-4) + 16px + var(--sp-3))",
                    paddingRight: "2.5rem",
                    fontSize: "var(--text-body-lg)",
                    lineHeight: "var(--lh-body-lg)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => { setShowConfirm((v) => !v); }}
                  aria-label={t(showConfirm ? "password_reset.set.password_hide" : "password_reset.set.password_show")}
                  className="absolute inset-y-0 right-0 flex items-center px-sp-4 text-fg-subtle hover:text-fg"
                >
                  {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              {(passwordsMatch || passwordsMismatch) && (
                <p
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                    color: passwordsMatch ? "var(--success-text)" : "var(--danger-text)",
                  }}
                >
                  {passwordsMatch
                    ? t("password_reset.set.passwords_match")
                    : t("password_reset.set.passwords_mismatch")}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !canSubmit}
              className="w-full rounded-md bg-accent font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
              style={{ marginTop: "var(--sp-2)", height: "44px", fontSize: "var(--text-body-lg)", lineHeight: 1 }}
            >
              {isSubmitting ? t("password_reset.set.submit_loading") : t("password_reset.set.submit")}
            </button>
          </Form>

          <div className="text-center" style={{ marginTop: "var(--sp-6)" }}>
            <Link
              to="/login"
              className="text-fg-muted hover:text-fg"
              style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
            >
              {t("password_reset.set.back_to_sign_in")}
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}

function MissingTokenState({ t }: { t: (key: string) => string }) {
  return (
    <>
      <div className="mb-sp-6">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("password_reset.set.title")}
        </h2>
      </div>

      <div
        role="alert"
        className="mb-sp-6 flex items-start gap-sp-3 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3"
      >
        <p
          className="text-danger-text"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("password_reset.set.error_missing_token")}
        </p>
      </div>

      <Link
        to="/forgot-password"
        className="flex w-full items-center justify-center rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("password_reset.forgot.submit")}
      </Link>

      <div className="mt-sp-6 text-center">
        <Link
          to="/login"
          className="text-fg-muted hover:text-fg"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("password_reset.set.back_to_sign_in")}
        </Link>
      </div>
    </>
  );
}

const STRENGTH_LEVELS: readonly {
  labelKey: string;
  color: string;
  textColor: string;
}[] = [
  {
    labelKey: "password_reset.set.strength_too_short",
    color: "var(--border)",
    textColor: "var(--fg-subtle)",
  },
  {
    labelKey: "password_reset.set.strength_weak",
    color: "var(--danger)",
    textColor: "var(--danger-text)",
  },
  {
    labelKey: "password_reset.set.strength_fair",
    color: "var(--warning)",
    textColor: "var(--warning-text)",
  },
  {
    labelKey: "password_reset.set.strength_good",
    color: "var(--accent)",
    textColor: "var(--accent-text)",
  },
  {
    labelKey: "password_reset.set.strength_strong",
    color: "var(--success)",
    textColor: "var(--success-text)",
  },
] as const;

function PasswordStrength({
  score,
  value,
  t,
}: {
  score: 0 | 1 | 2 | 3 | 4;
  value: string;
  t: (key: string) => string;
}) {
  const level = STRENGTH_LEVELS[score] ?? {
    labelKey: "password_reset.set.strength_too_short",
    color: "var(--border)",
    textColor: "var(--fg-subtle)",
  };
  return (
    <div className="flex flex-col gap-sp-2 pt-sp-1">
      {/* 4-bar indicator */}
      <div className="flex gap-sp-2" aria-hidden="true">
        {([0, 1, 2, 3] as const).map((i) => (
          <div
            key={i}
            className="h-1 flex-1 rounded-full transition-colors"
            style={{
              background: i < score ? level.color : "var(--border)",
            }}
          />
        ))}
      </div>

      {/* Label + requirements */}
      <div className="flex items-center justify-between">
        <span
          style={{
            fontSize: "var(--text-small)",
            lineHeight: "var(--lh-small)",
            color: value ? level.textColor : "var(--fg-subtle)",
          }}
        >
          {value ? t(level.labelKey) : t("password_reset.set.strength_empty")}
        </span>
        <span
          className="text-fg-faint"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("password_reset.set.strength_requirements")}
        </span>
      </div>
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
