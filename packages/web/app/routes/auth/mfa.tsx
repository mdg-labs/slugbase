import { useTranslate } from "@tolgee/react";
import { useState } from "react";
import type { ActionFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { TotpInput } from "../../components/TotpInput.js";

const API_BASE_URL = (): string => process.env["API_BASE_URL"] ?? "";

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

  const redirectResponse = redirect("/");
  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) {
    redirectResponse.headers.set("Set-Cookie", setCookie);
  }
  return redirectResponse;
}

export default function MfaRoute() {
  const { t } = useTranslate();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [totpCode, setTotpCode] = useState("");

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
          <div className="mb-sp-4 flex items-center gap-sp-3">
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

          {/* Back link */}
          <a
            href="/login"
            className="mb-sp-5 flex items-center gap-sp-2 text-fg-muted hover:text-fg"
            style={{
              fontSize: "var(--text-small)",
              lineHeight: "var(--lh-small)",
            }}
          >
            <BackArrowIcon />
            {t("mfa.challenge.back_to_signin")}
          </a>

          {/* Heading */}
          <div className="mb-sp-7">
            <h2
              className="text-fg font-semibold"
              style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
            >
              {t("mfa.challenge.title")}
            </h2>
            <p
              className="mt-sp-2 text-fg-muted"
              style={{
                fontSize: "var(--text-body)",
                lineHeight: "var(--lh-body)",
              }}
            >
              {mode === "totp"
                ? t("mfa.challenge.subtitle_totp")
                : t("mfa.challenge.subtitle_backup")}
            </p>
          </div>

          <Form method="post" className="flex flex-col gap-sp-5" noValidate>
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

            {mode === "totp" ? (
              <div className="flex flex-col gap-sp-2">
                <label
                  className="font-medium text-fg-muted"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                >
                  {t("mfa.challenge.label_code")}
                </label>
                <TotpInput
                  value={totpCode}
                  onChange={setTotpCode}
                  disabled={isSubmitting}
                />
                <input type="hidden" name="code" value={totpCode} />
              </div>
            ) : (
              <div className="flex flex-col gap-sp-2">
                <label
                  htmlFor="backup-code"
                  className="font-medium text-fg-muted"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                >
                  {t("mfa.challenge.label_backup_code")}
                </label>
                <input
                  id="backup-code"
                  name="code"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("mfa.challenge.placeholder_backup")}
                  disabled={isSubmitting}
                  className="w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-mono)",
                    lineHeight: "var(--lh-mono)",
                  }}
                />
              </div>
            )}

            <button
              type="submit"
              disabled={
                isSubmitting ||
                (mode === "totp" && totpCode.replace(/\D/g, "").length < 6)
              }
              className="mt-sp-2 w-full rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                fontSize: "var(--text-body)",
                lineHeight: "var(--lh-body)",
              }}
            >
              {isSubmitting
                ? t("mfa.challenge.submit_loading")
                : t("mfa.challenge.submit")}
            </button>
          </Form>

          {/* Mode toggle */}
          <div
            className="mt-sp-6 text-center"
            style={{
              fontSize: "var(--text-small)",
              lineHeight: "var(--lh-small)",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === "totp" ? "backup" : "totp"));
                setTotpCode("");
              }}
              className="text-accent-text hover:underline"
            >
              {mode === "totp"
                ? t("mfa.challenge.toggle_use_backup")
                : t("mfa.challenge.toggle_use_totp")}
            </button>
          </div>
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
      style={{
        opacity,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-mono)",
        lineHeight: "var(--lh-mono)",
      }}
    >
      <span className="text-accent-text">{src}</span>
      <span className="text-fg-subtle">→</span>
      <span className="text-fg-muted">{dst}</span>
    </div>
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
