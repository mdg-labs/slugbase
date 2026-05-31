import { useTranslate } from "@tolgee/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

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

const STRENGTH_COLORS = [
  "",
  "bg-danger",
  "bg-warning",
  "bg-warning",
  "bg-success",
] as const;

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

  const redirectResponse = redirect("/login");
  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) {
    redirectResponse.headers.set("Set-Cookie", setCookie);
  }
  return redirectResponse;
}

export default function SetupRoute() {
  const { t } = useTranslate();
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
    <div className="flex min-h-screen bg-canvas font-sans">
      {/* Brand rail — hidden on small screens */}
      <aside
        className="hidden lg:flex w-[400px] shrink-0 flex-col justify-between border-r border-[color:var(--border)] bg-base p-sp-8"
        aria-hidden="true"
      >
        <div className="flex items-center gap-sp-3">
          <img src="/slugbase_icon.svg" alt="" width={28} height={28} className="shrink-0" />
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

      {/* Form pane */}
      <div className="flex flex-1 items-center justify-center p-sp-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-sp-7 flex items-center gap-sp-3">
            <img src="/slugbase_icon.svg" alt="" width={24} height={24} className="shrink-0" />
            <span
              className="text-fg font-semibold"
              style={{ fontSize: "var(--text-h3)", lineHeight: "var(--lh-h3)" }}
            >
              SlugBase
            </span>
          </div>

          <div className="mb-sp-7">
            <h2
              className="text-fg font-semibold"
              style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
            >
              {t("setup.title")}
            </h2>
            <p
              className="mt-sp-2 text-fg-muted"
              style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
            >
              {t("setup.subtitle")}
            </p>
          </div>

          <Form method="post" className="flex flex-col gap-sp-5" noValidate>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-sp-3 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3"
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
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="name"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
              >
                {t("setup.name_label")}
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                required
                placeholder={t("setup.name_placeholder")}
                className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              />
            </div>

            {/* Email */}
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="email"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
              >
                {t("setup.email_label")}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder={t("setup.email_placeholder")}
                className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              />
            </div>

            {/* Password + strength */}
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="password"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
              >
                {t("setup.password_label")}
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); }}
                  className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 pr-10 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                  style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
                />
                <button
                  type="button"
                  onClick={() => { setShowPassword((v) => !v); }}
                  aria-label={t(
                    showPassword ? "setup.password_hide" : "setup.password_show",
                  )}
                  className="absolute inset-y-0 right-0 flex items-center px-sp-4 text-fg-subtle hover:text-fg"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              {strength > 0 && (
                <div className="flex flex-col gap-sp-1" aria-live="polite">
                  <div className="flex gap-sp-1" role="presentation">
                    {([1, 2, 3, 4] as const).map((level) => (
                      <div
                        key={level}
                        className={`h-1 flex-1 rounded-full transition-colors duration-[var(--duration-fast)] ${
                          strength >= level
                            ? STRENGTH_COLORS[strength]
                            : "bg-[color:var(--border)]"
                        }`}
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

            {/* Workspace name */}
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="workspaceName"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
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
                className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              />
            </div>

            {/* Workspace slug */}
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="workspaceSlug"
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
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
                className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 font-[family-name:var(--font-mono)] text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas"
                style={{
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
              className="mt-sp-2 w-full rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
              style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
            >
              {isSubmitting ? t("setup.submit_loading") : t("setup.submit")}
            </button>
          </Form>
        </div>
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
