import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { applyApiSessionCookie, redirectAfterFormPost } from "../../lib/api-session-cookie.js";
import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";
import {
  AuthShell,
  LockFieldIcon,
  MailFieldIcon,
  UserFieldIcon,
} from "../auth/AuthShell.js";
import { createRouteMeta } from "../../lib/route-meta.js";

const API_BASE_URL = () => getServerApiBaseUrl();

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
  "setup.password_strength.very_weak",
  "setup.password_strength.weak",
  "setup.password_strength.fair",
  "setup.password_strength.strong",
] as const;

const STRENGTH_COLORS = ["", "bg-danger", "bg-warning", "bg-warning", "bg-success"] as const;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const res = await fetch(`${API_BASE_URL()}/setup/status`);
    if (res.ok) {
      const data = (await res.json()) as { needsSetup: boolean };
      if (!data.needsSetup) return redirect("/login");
    }
  } catch {
    // If backend is unreachable let the form render
  }
  return {};
}

type ActionResult =
  | { error: "setup.error_already_done" }
  | { error: "setup.error_invalid_email" }
  | { error: "setup.error_password_too_short" }
  | { error: "setup.error_invalid_slug" }
  | { error: "setup.error_generic" };

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult | Response> {
  const formData = await request.formData();
  const rawName = formData.get("name");
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");
  const rawWorkspaceName = formData.get("workspaceName");
  const rawWorkspaceSlug = formData.get("workspaceSlug");

  const name = typeof rawName === "string" ? rawName.trim() : "";
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  const workspaceName =
    typeof rawWorkspaceName === "string" ? rawWorkspaceName.trim() : "";
  const workspaceSlug =
    typeof rawWorkspaceSlug === "string" ? rawWorkspaceSlug.trim() : "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "setup.error_invalid_email" };
  }
  if (password.length < 8) {
    return { error: "setup.error_password_too_short" };
  }
  if (!workspaceSlug || !SLUG_PATTERN.test(workspaceSlug)) {
    return { error: "setup.error_invalid_slug" };
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/setup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, workspaceName, workspaceSlug }),
    });
  } catch {
    return { error: "setup.error_generic" };
  }

  if (res.status === 409) {
    return { error: "setup.error_already_done" };
  }

  if (!res.ok) {
    return { error: "setup.error_generic" };
  }

  const redirectResponse = redirectAfterFormPost("/");
  applyApiSessionCookie(redirectResponse, res);
  return redirectResponse;
}

export const meta = createRouteMeta("app.page.setup");

export default function SetupRoute() {
  const { t } = useTranslation();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  const strength = calcPasswordStrength(password);

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;

  /** Auto-derive workspace slug from name until the user edits it manually. */
  function handleWorkspaceNameChange(value: string) {
    setWorkspaceName(value);
    if (!slugEdited) {
      setWorkspaceSlug(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 32),
      );
    }
  }

  return (
    <AuthShell showSlugRows={false}>
      {/* Eyebrow badge */}
      <div style={{ marginBottom: "var(--sp-5)" }}>
        <span
          className="inline-flex items-center text-accent-text bg-[color:var(--accent-subtle)] border border-[color:var(--accent-border)]"
          style={{
            gap: "var(--sp-3)",
            padding: "var(--sp-3) var(--sp-4)",
            borderRadius: "var(--r-full)",
            fontWeight: "var(--weight-medium)",
            fontSize: "var(--text-micro)",
            lineHeight: 1,
            letterSpacing: "var(--track-wide)",
            textTransform: "uppercase",
          }}
        >
          <TerminalIcon />
          {t("setup.eyebrow")}
        </span>
      </div>

      {/* Step breadcrumb */}
      <div
        className="flex items-center"
        style={{ gap: "var(--sp-3)", marginBottom: "var(--sp-7)" }}
      >
        <StepIndicator number={1} label={t("setup.step_admin_account")} active />
        <span className="flex-1 h-px bg-[color:var(--border-subtle)]" aria-hidden="true" />
        <StepIndicator number={2} label={t("setup.step_first_workspace")} active={false} />
      </div>

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
          {t("setup.title")}
        </h2>
        <p
          className="text-fg-muted"
          style={{ margin: 0, fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
        >
          {t("setup.subtitle")}
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

        {/* Name */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="name"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("setup.name_label")}
          </label>
          <div className="relative">
            <span
              className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
              style={{ paddingLeft: "var(--sp-4)" }}
            >
              <UserFieldIcon />
            </span>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              placeholder={t("setup.name_placeholder")}
              className="w-full rounded-md border border-[color:var(--border)] bg-raised text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
              style={{
                height: "42px",
                paddingLeft: "calc(var(--sp-4) + 16px + var(--sp-3))",
                paddingRight: "var(--sp-5)",
                fontSize: "var(--text-body-lg)",
                lineHeight: "var(--lh-body-lg)",
              }}
            />
          </div>
        </div>

        {/* Email */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="email"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("setup.email_label")}
          </label>
          <div className="relative">
            <span
              className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
              style={{ paddingLeft: "var(--sp-4)" }}
            >
              <MailFieldIcon />
            </span>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              placeholder={t("setup.email_placeholder")}
              className="w-full rounded-md border border-[color:var(--border)] bg-raised text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
              style={{
                height: "42px",
                paddingLeft: "calc(var(--sp-4) + 16px + var(--sp-3))",
                paddingRight: "var(--sp-5)",
                fontSize: "var(--text-body-lg)",
                lineHeight: "var(--lh-body-lg)",
              }}
            />
          </div>
        </div>

        {/* Password + strength */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="password"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("setup.password_label")}
          </label>
          <div className="relative">
            <span
              className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
              style={{ paddingLeft: "var(--sp-4)" }}
            >
              <LockFieldIcon />
            </span>
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              placeholder={t("auth.password.mask_placeholder")}
              value={password}
              onChange={(e) => { setPassword(e.target.value); }}
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
              onClick={() => { setShowPassword((v) => !v); }}
              aria-label={t(showPassword ? "setup.password_hide" : "setup.password_show")}
              className="absolute inset-y-0 right-0 flex items-center px-sp-4 text-fg-subtle hover:text-fg"
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          {strength > 0 && (
            <div className="flex flex-col" style={{ gap: "var(--sp-3)" }} aria-live="polite">
              <div
                className="grid"
                style={{ gridTemplateColumns: "repeat(4,1fr)", gap: "var(--sp-3)" }}
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
              <p
                className="text-fg-subtle"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
              >
                {t(STRENGTH_KEYS[strength] ?? "setup.password_strength.weak")}
              </p>
            </div>
          )}
        </div>

        {/* Setup divider - "First workspace" */}
        <div
          className="flex items-center"
          style={{ gap: "var(--sp-4)", margin: "var(--sp-2) 0" }}
        >
          <span className="flex-1 h-px bg-[color:var(--border-subtle)]" aria-hidden="true" />
          <span
            className="text-fg-subtle"
            style={{
              fontWeight: "var(--weight-medium)",
              fontSize: "var(--text-micro)",
              lineHeight: 1,
              letterSpacing: "var(--track-wide)",
              textTransform: "uppercase",
            }}
          >
            {t("setup.section_workspace_divider")}
          </span>
          <span className="flex-1 h-px bg-[color:var(--border-subtle)]" aria-hidden="true" />
        </div>

        {/* Workspace name */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="workspaceName"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("setup.workspace_name_label")}
          </label>
          <input
            id="workspaceName"
            name="workspaceName"
            type="text"
            required
            placeholder={t("setup.workspace_name_placeholder")}
            value={workspaceName}
            onChange={(e) => { handleWorkspaceNameChange(e.target.value); }}
            className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-5 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
            style={{ height: "42px", fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
          />
        </div>

        {/* Workspace slug */}
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="workspaceSlug"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("setup.workspace_slug_label")}
          </label>
          <input
            id="workspaceSlug"
            name="workspaceSlug"
            type="text"
            required
            placeholder={t("setup.workspace_slug_placeholder")}
            value={workspaceSlug}
            onChange={(e) => {
              setSlugEdited(true);
              setWorkspaceSlug(e.target.value);
            }}
            className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-5 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
            style={{
              height: "42px",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              lineHeight: "var(--lh-mono)",
            }}
          />
          <p
            className="text-fg-subtle"
            style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
          >
            {t("setup.workspace_slug_hint")}
          </p>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-accent font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
          style={{ marginTop: "var(--sp-2)", height: "44px", fontSize: "var(--text-body-lg)", lineHeight: 1 }}
        >
          {isSubmitting ? t("setup.submit_loading") : t("setup.submit")}
        </button>
      </Form>

      {/* Owner security note */}
      <div
        className="flex items-start rounded-md border border-[color:var(--border-subtle)] bg-raised"
        style={{ gap: "var(--sp-4)", marginTop: "var(--sp-6)", padding: "var(--sp-4) var(--sp-5)" }}
      >
        <ShieldCheckIcon />
        <p
          className="text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("setup.owner_security_note")}
        </p>
      </div>
    </AuthShell>
  );
}

/* ── Step indicator ──────────────────────────────────────── */

function StepIndicator({ number, label, active }: { number: number; label: string; active: boolean }) {
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
      <span
        className={active ? "text-accent-fg" : "text-fg-subtle"}
        style={{
          display: "inline-grid",
          placeItems: "center",
          width: "18px",
          height: "18px",
          borderRadius: "99px",
          background: active ? "var(--accent)" : "var(--border)",
          fontWeight: "var(--weight-semi)",
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        {number}
      </span>
      <span
        className={active ? "text-fg" : "text-fg-subtle"}
        style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
      >
        {label}
      </span>
    </div>
  );
}

/* ── Icons ───────────────────────────────────────────────── */

function TerminalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function ShieldCheckIcon() {
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
      className="mt-px shrink-0 text-fg-subtle"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
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
