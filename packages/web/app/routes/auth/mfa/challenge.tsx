import { useTranslation } from "react-i18next";
import { getServerApiBaseUrl } from "../../../lib/server-api-base-url.js";
import { useState } from "react";
import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";
import { applyApiSessionCookie, redirectAfterFormPost } from "../../../lib/api-session-cookie.js";
import { TotpInput } from "../../../components/TotpInput.js";
import { AuthShell, KeyFieldIcon } from "../AuthShell.js";
import { createRouteMeta } from "../../../lib/route-meta.js";

const API_BASE_URL = () => getServerApiBaseUrl();

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const rawCode = formData.get("code");
  const code = typeof rawCode === "string" ? rawCode.trim() : "";

  if (!code) {
    return { error: "mfa.challenge.error_invalid" as const };
  }

  let res: Response;
  try {
    const cookie = request.headers.get("Cookie") ?? "";
    res = await fetch(`${API_BASE_URL()}/auth/mfa/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { error: "mfa.challenge.error_generic" as const };
  }

  if (res.status === 401) {
    return { error: "mfa.challenge.error_invalid" as const };
  }

  if (!res.ok) {
    return { error: "mfa.challenge.error_generic" as const };
  }

  const redirectResponse = redirectAfterFormPost("/");
  applyApiSessionCookie(redirectResponse, res);
  return redirectResponse;
}

export const meta = createRouteMeta("app.page.mfa");

export default function MfaChallengeRoute() {
  const { t } = useTranslation();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [totpCode, setTotpCode] = useState("");

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <AuthShell>
      {/* Back link */}
      <a
        href="/login"
        className="flex items-center text-fg-muted hover:text-fg"
        style={{ marginBottom: "var(--sp-5)", fontSize: "var(--text-small)", lineHeight: "var(--lh-small)", gap: "var(--sp-3)" }}
      >
        <BackArrowIcon />
        {t("mfa.challenge.back_to_signin")}
      </a>

      {/* Heading */}
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
          {t("mfa.challenge.title")}
        </h2>
        <p
          className="text-fg-muted"
          style={{ margin: 0, fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
        >
          {mode === "totp"
            ? t("mfa.challenge.subtitle_totp")
            : t("mfa.challenge.subtitle_backup")}
        </p>
      </div>

      <Form method="post" className="flex flex-col" noValidate style={{ gap: "var(--sp-6)" }} data-testid="mfa-challenge-form">
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

        {mode === "totp" ? (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)" }} data-testid="mfa-code-input">
            <label
              className="font-medium text-fg-muted"
              style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
            >
              {t("mfa.challenge.label_code")}
            </label>
            <TotpInput value={totpCode} onChange={setTotpCode} disabled={isSubmitting} />
            <input type="hidden" name="code" value={totpCode} />
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
            <label
              htmlFor="backup-code"
              className="font-medium text-fg-muted"
              style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
            >
              {t("mfa.challenge.label_backup_code")}
            </label>
            <div className="relative">
              <span
                className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
                style={{ paddingLeft: "var(--sp-4)" }}
              >
                <KeyFieldIcon />
              </span>
              <input
                id="backup-code"
                name="code"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("mfa.challenge.placeholder_backup")}
                disabled={isSubmitting}
                className="w-full rounded-md border border-[color:var(--border)] bg-raised text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  height: "42px",
                  paddingLeft: "calc(var(--sp-4) + 16px + var(--sp-3))",
                  paddingRight: "var(--sp-5)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-mono)",
                  lineHeight: "var(--lh-mono)",
                }}
              />
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting || (mode === "totp" && totpCode.replace(/\D/g, "").length < 6)}
          className="w-full rounded-md bg-accent font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
          style={{ marginTop: "var(--sp-2)", height: "44px", fontSize: "var(--text-body-lg)", lineHeight: 1 }}
          data-testid="mfa-submit-btn"
        >
          {isSubmitting ? t("mfa.challenge.submit_loading") : t("mfa.challenge.submit")}
        </button>
      </Form>

      <div
        className="text-center"
        style={{ marginTop: "var(--sp-6)", fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "totp" ? "backup" : "totp"));
            setTotpCode("");
          }}
          className="text-accent-text hover:underline"
          data-testid="mfa-recovery-link"
        >
          {mode === "totp"
            ? t("mfa.challenge.toggle_use_backup")
            : t("mfa.challenge.toggle_use_totp")}
        </button>
      </div>
    </AuthShell>
  );
}

function BackArrowIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}
