import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { TotpInput } from "../../../components/TotpInput.js";
import { getSessionUser } from "../../../lib/session-client.js";
import { AuthShell } from "../AuthShell.js";

const API_BASE_URL = (): string => process.env["API_BASE_URL"] ?? "";

interface EnrolStartData {
  otpAuthUri: string;
  textSecret: string;
  qrDataUri: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (!user) return redirect("/login");

  const cookie = request.headers.get("Cookie") ?? "";
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/auth/mfa/enrol/start`, {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
    });
  } catch {
    return redirect("/login");
  }

  if (!res.ok) return redirect("/login");

  const data = (await res.json()) as EnrolStartData;
  return {
    otpAuthUri: data.otpAuthUri,
    textSecret: data.textSecret,
    qrDataUri: data.qrDataUri,
  };
}

/** Prevent loader re-run after action - backup codes must not re-trigger enrol/start */
export function shouldRevalidate() {
  return false;
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const rawCode = formData.get("totpCode");
  const totpCode = typeof rawCode === "string" ? rawCode.trim() : "";

  if (!totpCode || totpCode.replace(/\D/g, "").length < 6) {
    return { error: "mfa.enroll.error_invalid" as const };
  }

  let res: Response;
  try {
    const cookie = request.headers.get("Cookie") ?? "";
    res = await fetch(`${API_BASE_URL()}/auth/mfa/enrol/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ totpCode }),
    });
  } catch {
    return { error: "mfa.enroll.error_generic" as const };
  }

  if (res.status === 401) {
    return { error: "mfa.enroll.error_invalid" as const };
  }

  if (!res.ok) {
    return { error: "mfa.enroll.error_generic" as const };
  }

  const data = (await res.json()) as { backupCodes: string[] };
  return { backupCodes: data.backupCodes };
}

export default function MfaEnrollRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [totpCode, setTotpCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [codesConfirmed, setCodesConfirmed] = useState(false);

  const error =
    actionData && "error" in actionData ? actionData.error : undefined;
  const backupCodes: string[] | null =
    actionData && "backupCodes" in actionData
      ? (actionData.backupCodes as string[])
      : null;

  const { otpAuthUri, textSecret, qrDataUri } = loaderData;

  const handleCopyCodes = (): void => {
    if (!backupCodes) return;
    void navigator.clipboard.writeText(backupCodes.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  };

  return (
    <AuthShell showSlugRows={false}>
      <div data-testid="mfa-enroll-section">
        {backupCodes !== null ? (
          <div data-testid="mfa-backup-codes">
            <BackupCodesStep
              backupCodes={backupCodes}
              copied={copied}
              codesConfirmed={codesConfirmed}
              onCopy={handleCopyCodes}
              onConfirmChange={setCodesConfirmed}
            />
          </div>
        ) : (
          <EnrollConfirmStep
            otpAuthUri={otpAuthUri}
            textSecret={textSecret}
            qrDataUri={qrDataUri}
            totpCode={totpCode}
            onTotpChange={setTotpCode}
            isSubmitting={isSubmitting}
            error={error}
          />
        )}
      </div>
    </AuthShell>
  );
}

/* ────────────────────────────────────────────────────────────
   Step 1 - QR code + TOTP confirmation
   ──────────────────────────────────────────────────────────── */

interface EnrollConfirmStepProps {
  otpAuthUri: string;
  textSecret: string;
  qrDataUri: string;
  totpCode: string;
  onTotpChange: (v: string) => void;
  isSubmitting: boolean;
  error: string | undefined;
}

function EnrollConfirmStep({
  textSecret,
  qrDataUri,
  totpCode,
  onTotpChange,
  isSubmitting,
  error,
}: EnrollConfirmStepProps) {
  const { t } = useTranslation();
  const [showSecret, setShowSecret] = useState(false);

  return (
    <>
      {/* Heading */}
      <div className="mb-sp-6">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("mfa.enroll.title")}
        </h2>
        <p
          className="mt-sp-2 text-fg-muted"
          style={{
            fontSize: "var(--text-body)",
            lineHeight: "var(--lh-body)",
          }}
        >
          {t("mfa.enroll.subtitle")}
        </p>
      </div>

      {/* QR code */}
      <div className="mb-sp-6 flex justify-center">
        <div className="rounded-lg border border-[color:var(--border)] bg-white p-sp-3">
          <img
            src={qrDataUri}
            alt={t("mfa.enroll.qr_alt")}
            width={180}
            height={180}
            className="block"
            data-testid="mfa-qr-code"
          />
        </div>
      </div>

      {/* Manual code toggle */}
      <div className="mb-sp-6">
        <button
          type="button"
          onClick={() => { setShowSecret((s) => !s); }}
          className="text-accent-text hover:underline"
          style={{
            fontSize: "var(--text-small)",
            lineHeight: "var(--lh-small)",
          }}
        >
          {t("mfa.enroll.text_secret_label")}
        </button>
        {showSecret && (
          <div
            className="mt-sp-2 rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 break-all select-all text-fg"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              lineHeight: "var(--lh-mono)",
            }}
            aria-live="polite"
            data-testid="mfa-setup-code"
          >
            {textSecret}
          </div>
        )}
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

        <div className="flex flex-col gap-sp-2" data-testid="mfa-verify-input">
          <label
            className="font-medium text-fg-muted"
            style={{
              fontSize: "var(--text-small)",
              lineHeight: "var(--lh-small)",
            }}
          >
            {t("mfa.enroll.label_confirm_code")}
          </label>
          <TotpInput
            value={totpCode}
            onChange={onTotpChange}
            disabled={isSubmitting}
          />
          <input type="hidden" name="totpCode" value={totpCode} />
        </div>

        <button
          type="submit"
          disabled={
            isSubmitting || totpCode.replace(/\D/g, "").length < 6
          }
          className="w-full rounded-md bg-accent px-sp-6 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            fontSize: "var(--text-body)",
            lineHeight: "var(--lh-body)",
          }}
          data-testid="mfa-verify-submit"
        >
          {isSubmitting
            ? t("mfa.enroll.submit_loading")
            : t("mfa.enroll.submit_confirm")}
        </button>
      </Form>
    </>
  );
}

/* ────────────────────────────────────────────────────────────
   Step 2 - Backup codes (shown once)
   ──────────────────────────────────────────────────────────── */

interface BackupCodesStepProps {
  backupCodes: string[];
  copied: boolean;
  codesConfirmed: boolean;
  onCopy: () => void;
  onConfirmChange: (v: boolean) => void;
}

function BackupCodesStep({
  backupCodes,
  copied,
  codesConfirmed,
  onCopy,
  onConfirmChange,
}: BackupCodesStepProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* Heading */}
      <div className="mb-sp-5">
        <h2
          className="text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("mfa.backup_codes.title")}
        </h2>
      </div>

      {/* One-time warning */}
      <div
        role="alert"
        className="mb-sp-5 flex items-start gap-sp-3 rounded-md border border-[color:var(--warning-subtle)] bg-[color:var(--warning-subtle)] px-sp-4 py-sp-3"
      >
        <WarningIcon />
        <p
          className="text-warning-text"
          style={{
            fontSize: "var(--text-small)",
            lineHeight: "var(--lh-small)",
          }}
        >
          {t("mfa.backup_codes.warning")}
        </p>
      </div>

      {/* Backup codes grid */}
      <div
        className="mb-sp-5 grid grid-cols-2 gap-sp-2 rounded-lg border border-[color:var(--border)] bg-raised p-sp-4"
        aria-label={t("mfa.backup_codes.title")}
      >
        {backupCodes.map((code) => (
          <div
            key={code}
            className="select-all py-sp-1 text-fg"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              lineHeight: "var(--lh-mono)",
            }}
          >
            {code}
          </div>
        ))}
      </div>

      {/* Copy button */}
      <button
        type="button"
        onClick={onCopy}
        className="mb-sp-6 w-full rounded-md border border-[color:var(--border)] bg-raised px-sp-6 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2"
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--lh-body)",
        }}
      >
        {copied ? t("mfa.backup_codes.copied") : t("mfa.backup_codes.copy")}
      </button>

      {/* Confirmation checkbox */}
      <label className="mb-sp-6 flex cursor-pointer items-start gap-sp-3">
        <input
          type="checkbox"
          checked={codesConfirmed}
          onChange={(e) => { onConfirmChange(e.target.checked); }}
          className="mt-0.5 h-4 w-4 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
        />
        <span
          className="text-fg-muted"
          style={{
            fontSize: "var(--text-small)",
            lineHeight: "var(--lh-small)",
          }}
        >
          {t("mfa.backup_codes.confirm_label")}
        </span>
      </label>

      {/* Continue */}
      <a
        href="/"
        aria-disabled={!codesConfirmed}
        onClick={(e) => {
          if (!codesConfirmed) e.preventDefault();
        }}
        className="block w-full rounded-md bg-accent px-sp-6 py-sp-3 text-center font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--lh-body)",
        }}
      >
        {t("mfa.backup_codes.submit")}
      </a>
    </>
  );
}

function WarningIcon() {
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
      className="mt-0.5 shrink-0 text-warning-text"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
