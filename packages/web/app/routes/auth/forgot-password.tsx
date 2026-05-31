import { useTranslate } from "@tolgee/react";
import type { ActionFunctionArgs } from "react-router";
import { Form, Link, useActionData, useNavigation } from "react-router";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

/**
 * Non-enumerating: always returns sent=true regardless of backend response
 * so the UI cannot reveal whether an email is registered.
 */
export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const rawEmail = formData.get("email");
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";

  if (email) {
    try {
      await fetch(`${API_BASE_URL()}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // non-enumerating: always show success regardless of backend response or network error
    }
  }

  return { sent: true as const, email };
}

export default function ForgotPasswordRoute() {
  const { t } = useTranslate();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const sent = actionData?.sent === true;
  const submittedEmail = actionData?.email ?? "";

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
              style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
            >
              {t("auth.brand.headline")}
            </h1>
            <p
              className="text-fg-muted"
              style={{ fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
            >
              {t("auth.brand.subline")}
            </p>
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

          {sent ? (
            <SuccessState email={submittedEmail} t={t} />
          ) : (
            <RequestForm isSubmitting={isSubmitting} t={t} />
          )}
        </div>
      </div>
    </div>
  );
}

function RequestForm({
  isSubmitting,
  t,
}: {
  isSubmitting: boolean;
  t: (key: string) => string;
}) {
  return (
    <>
      {/* Heading */}
      <div className="mb-sp-7">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("password_reset.forgot.title")}
        </h2>
        <p
          className="mt-sp-2 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("password_reset.forgot.subtitle")}
        </p>
      </div>

      <Form method="post" className="flex flex-col gap-sp-5" noValidate>
        {/* Email field */}
        <div className="flex flex-col gap-sp-2">
          <label
            htmlFor="email"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
          >
            {t("password_reset.forgot.email_label")}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder={t("password_reset.forgot.email_placeholder")}
            className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
            style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
          />
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-sp-2 w-full rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {isSubmitting
            ? t("password_reset.forgot.submit_loading")
            : t("password_reset.forgot.submit")}
        </button>
      </Form>

      {/* Back link */}
      <div className="mt-sp-6 text-center">
        <Link
          to="/login"
          className="text-fg-muted hover:text-fg"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("password_reset.forgot.back_to_sign_in")}
        </Link>
      </div>

      {/* Non-enumerating security note */}
      <div
        className="mt-sp-6 flex items-start gap-sp-3 rounded-md border border-[color:var(--border-subtle)] bg-raised px-sp-4 py-sp-3"
      >
        <ShieldIcon />
        <p
          className="text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("password_reset.forgot.non_enumerating_note")}
        </p>
      </div>
    </>
  );
}

function SuccessState({
  email,
  t,
}: {
  email: string;
  t: (key: string) => string;
}) {
  return (
    <>
      {/* Success icon */}
      <div
        className="mb-sp-6 flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--success-subtle)]"
        aria-hidden="true"
      >
        <MailCheckIcon />
      </div>

      {/* Heading */}
      <div className="mb-sp-6">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("password_reset.forgot.success_title")}
        </h2>
        <p
          className="mt-sp-2 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("password_reset.forgot.success_message")}
        </p>
      </div>

      {/* Submitted email */}
      {email && (
        <div
          className="mb-sp-6 flex items-center gap-sp-3 rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}
        >
          <MailIcon />
          <span className="text-fg-muted">{email}</span>
        </div>
      )}

      {/* Back to sign in */}
      <Link
        to="/login"
        className="flex w-full items-center justify-center rounded-md border border-[color:var(--border)] bg-raised px-sp-6 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("password_reset.forgot.back_to_sign_in")}
      </Link>
    </>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-px shrink-0 text-fg-subtle"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function MailCheckIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-success-text"
      aria-hidden="true"
    >
      <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      <path d="m16 19 2 2 4-4" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-fg-subtle"
      aria-hidden="true"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}
