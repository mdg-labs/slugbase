import { useTranslation } from "react-i18next";
import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppToast } from "../../components/feedback/AppToastProvider.js";
import { getSessionUser } from "../../lib/session-client.js";
import { AuthShell } from "./AuthShell.js";

const API_BASE_URL = () => getServerApiBaseUrl();

type LoaderData =
  | { mode: "pending"; email: string }
  | { mode: "complete"; success: true }
  | { mode: "complete"; success: false; error: string };

type ActionResult =
  | { intent: "resend"; ok: true }
  | { intent: "resend"; ok: false; error: string }
  | { intent: "correct"; ok: true; maskedEmail: string }
  | { intent: "correct"; ok: false; error: string };

export async function loader({ request }: LoaderFunctionArgs): Promise<LoaderData | Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (token) {
    const cookie = request.headers.get("Cookie") ?? "";
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE_URL()}/auth/verify-email?token=${encodeURIComponent(token)}`,
        { headers: cookie ? { Cookie: cookie } : {} },
      );
    } catch {
      return { mode: "complete", success: false, error: "auth.verify_email.complete_error_generic" };
    }

    if (res.ok) {
      return { mode: "complete", success: true };
    }

    if (res.status === 422) {
      return {
        mode: "complete",
        success: false,
        error: "auth.verify_email.complete_error_expired",
      };
    }

    return {
      mode: "complete",
      success: false,
      error: "auth.verify_email.complete_error_invalid",
    };
  }

  const user = await getSessionUser(request);
  if (!user) return redirect("/login");
  if (user.emailVerified) return redirect("/");

  return { mode: "pending", email: user.email };
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const formData = await request.formData();
  const intent = formData.get("_intent");
  const cookie = request.headers.get("Cookie") ?? "";
  const headers: HeadersInit = cookie ? { Cookie: cookie } : {};

  if (intent === "resend") {
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL()}/auth/resend-verification`, {
        method: "POST",
        headers,
      });
    } catch {
      return { intent: "resend", ok: false, error: "auth.verify_email.toast_resend_error" };
    }

    if (res.status === 429) {
      return { intent: "resend", ok: false, error: "auth.verify_email.toast_resend_rate_limit" };
    }

    if (!res.ok) {
      return { intent: "resend", ok: false, error: "auth.verify_email.toast_resend_error" };
    }

    return { intent: "resend", ok: true };
  }

  if (intent === "correct") {
    const rawEmail = formData.get("email");
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { intent: "correct", ok: false, error: "auth.verify_email.change_email_error_invalid" };
    }

    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL()}/auth/correct-signup-email`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      return { intent: "correct", ok: false, error: "auth.verify_email.toast_change_email_error" };
    }

    if (res.status === 409) {
      return { intent: "correct", ok: false, error: "auth.verify_email.change_email_error_taken" };
    }

    if (res.status === 429) {
      return { intent: "correct", ok: false, error: "auth.verify_email.toast_resend_rate_limit" };
    }

    if (!res.ok) {
      return { intent: "correct", ok: false, error: "auth.verify_email.toast_change_email_error" };
    }

    const data = (await res.json()) as { maskedEmail: string };
    return { intent: "correct", ok: true, maskedEmail: data.maskedEmail };
  }

  return { intent: "resend", ok: false, error: "auth.verify_email.toast_resend_error" };
}

export default function VerifyEmailRoute() {
  const { t } = useTranslation();
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { showToast, showError } = useAppToast();

  const pendingData = loaderData.mode === "pending" ? loaderData : null;
  const [displayEmail, setDisplayEmail] = useState(pendingData?.email ?? "");

  useEffect(() => {
    if (pendingData?.email) {
      setDisplayEmail(pendingData.email);
    }
  }, [pendingData?.email]);

  useEffect(() => {
    if (!actionData) return;

    if (actionData.intent === "resend") {
      if (actionData.ok) {
        showToast("auth.verify_email.toast_resend_success");
      } else {
        showError(t(actionData.error));
      }
      return;
    }

    if (actionData.ok) {
      setDisplayEmail(actionData.maskedEmail);
      showToast("auth.verify_email.toast_change_email_success");
    } else {
      showError(t(actionData.error));
    }
  }, [actionData, showToast, showError, t]);

  const resendSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("_intent") === "resend";
  const correctSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("_intent") === "correct";

  if (loaderData.mode === "complete") {
    return (
      <AuthShell>
        {loaderData.success ? (
          <CompleteSuccess t={t} />
        ) : (
          <CompleteError errorKey={loaderData.error} t={t} />
        )}
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div
        className="mb-sp-6 flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--success-subtle)]"
        aria-hidden="true"
      >
        <MailCheckIcon />
      </div>

      <div className="mb-sp-6">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("auth.verify_email.title")}
        </h2>
        <p
          className="mt-sp-2 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("auth.verify_email.subtitle", { email: displayEmail })}
        </p>
      </div>

      {displayEmail && (
        <div
          className="mb-sp-6 flex items-center gap-sp-3 rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}
        >
          <MailIcon />
          <span className="text-fg-muted">{displayEmail}</span>
        </div>
      )}

      <Link
        to="/login"
        className="mb-sp-4 flex w-full items-center justify-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-raised px-sp-6 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        <ArrowLeftIcon />
        {t("auth.verify_email.back_to_sign_in")}
      </Link>

      <Form method="post" className="mb-sp-6">
        <input type="hidden" name="_intent" value="resend" />
        <button
          type="submit"
          disabled={resendSubmitting}
          className="w-full rounded-md border border-[color:var(--border)] bg-transparent px-sp-6 py-sp-3 font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {resendSubmitting
            ? t("auth.verify_email.resend_loading")
            : t("auth.verify_email.resend_button")}
        </button>
      </Form>

      <div className="mb-sp-6 border-t border-[color:var(--border-subtle)] pt-sp-6">
        <p
          className="mb-sp-4 text-fg-muted"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("auth.verify_email.change_email_hint")}
        </p>
        <Form method="post" className="flex flex-col gap-sp-4">
          <input type="hidden" name="_intent" value="correct" />
          <div className="flex flex-col gap-sp-2">
            <label
              htmlFor="correct-email"
              className="font-medium text-fg-muted"
              style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
            >
              {t("auth.verify_email.change_email_label")}
            </label>
            <input
              id="correct-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder={t("auth.verify_email.change_email_placeholder")}
              className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
              style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
            />
          </div>
          <button
            type="submit"
            disabled={correctSubmitting}
            className="w-full rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
            style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
          >
            {correctSubmitting
              ? t("auth.verify_email.change_email_loading")
              : t("auth.verify_email.change_email_submit")}
          </button>
        </Form>
      </div>

      <Form method="post" action="/logout" className="mb-sp-6 text-center">
        <button
          type="submit"
          className="text-fg-subtle hover:text-fg hover:underline"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("auth.verify_email.logout_link")}
        </button>
      </Form>

      <div className="flex items-start gap-sp-3 rounded-md border border-[color:var(--border-subtle)] bg-raised px-sp-4 py-sp-3">
        <ShieldIcon />
        <p
          className="text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("auth.verify_email.non_enumerating_note")}
        </p>
      </div>
    </AuthShell>
  );
}


function CompleteSuccess({ t }: { t: (key: string) => string }) {
  return (
    <>
      <div
        className="mb-sp-6 flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--success-subtle)]"
        aria-hidden="true"
      >
        <MailCheckIcon />
      </div>
      <div className="mb-sp-6">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("auth.verify_email.complete_success_title")}
        </h2>
        <p
          className="mt-sp-2 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("auth.verify_email.complete_success_message")}
        </p>
      </div>
      <Link
        to="/login"
        className="flex w-full items-center justify-center rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("auth.verify_email.back_to_sign_in")}
      </Link>
    </>
  );
}

function CompleteError({
  errorKey,
  t,
}: {
  errorKey: string;
  t: (key: string) => string;
}) {
  return (
    <>
      <div
        className="mb-sp-6 flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--danger-subtle)]"
        aria-hidden="true"
      >
        <MailIcon />
      </div>
      <div className="mb-sp-6">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("auth.verify_email.complete_error_title")}
        </h2>
        <p
          className="mt-sp-2 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t(errorKey)}
        </p>
      </div>
      <Link
        to="/verify-email"
        className="mb-sp-4 flex w-full items-center justify-center rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("auth.verify_email.resend_button")}
      </Link>
      <Link
        to="/login"
        className="flex w-full items-center justify-center text-fg-muted hover:text-fg hover:underline"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {t("auth.verify_email.back_to_sign_in")}
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

function ArrowLeftIcon() {
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
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}
