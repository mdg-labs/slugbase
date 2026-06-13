import { Button, Input, Label } from "@slugbase/ui";
import { useState } from "react";

import { TotpInput } from "../../../../components/TotpInput.js";
import type { AccountSettingsData } from "../account.types.js";
import type { MfaEnrolStartData } from "../account-api.js";
import { ShownOncePanel } from "./ShownOncePanel.js";
import { SettingsSection } from "./SettingsSection.js";

interface MfaSectionProps {
  account: AccountSettingsData;
  onStartEnrol: () => Promise<MfaEnrolStartData>;
  onConfirmEnrol: (totpCode: string) => Promise<string[]>;
  onDisable: (totpCode: string) => Promise<void>;
  onRegenerate: (totpCode: string) => Promise<string[]>;
  onAccountRefresh: () => void;
  t: (key: string, params?: Record<string, string>) => string;
}

export function MfaSection({
  account,
  onStartEnrol,
  onConfirmEnrol,
  onDisable,
  onRegenerate,
  onAccountRefresh,
  t,
}: MfaSectionProps) {
  const [enrolData, setEnrolData] = useState<MfaEnrolStartData | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [actionCode, setActionCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const data = await onStartEnrol();
      setEnrolData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.account.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const codes = await onConfirmEnrol(totpCode);
      setBackupCodes(codes);
      setEnrolData(null);
      setTotpCode("");
      onAccountRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.account.mfa.error_invalid"));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onDisable(actionCode);
      setActionCode("");
      onAccountRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.account.mfa.error_invalid"));
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const codes = await onRegenerate(actionCode);
      setBackupCodes(codes);
      setShowRegenerate(false);
      setActionCode("");
      onAccountRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.account.mfa.error_invalid"));
    } finally {
      setBusy(false);
    }
  };

  if (backupCodes) {
    return (
      <SettingsSection
        titleKey="settings.account.mfa.title"
        descriptionKey="settings.account.mfa.description"
        t={t}
      >
        <ShownOncePanel
          values={backupCodes}
          labelKey="settings.account.mfa.backup_codes_label"
          warningKey="settings.account.mfa.backup_codes_warning"
          copyActionKey="settings.account.mfa.backup_codes_copy"
          copiedKey="settings.account.mfa.backup_codes_copied"
          t={t}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => { setBackupCodes(null); }}
        >
          {t("settings.account.mfa.backup_codes_done")}
        </Button>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      titleKey="settings.account.mfa.title"
      descriptionKey="settings.account.mfa.description"
      t={t}
    >
      {error ? (
        <p className="m-0 text-danger-text" role="alert" style={{ fontSize: "var(--text-small)" }}>
          {error}
        </p>
      ) : null}

      {account.mfaState === "not_enrolled" && !enrolData ? (
        <div className="flex flex-col gap-sp-5">
          <p className="m-0 text-fg-muted" style={{ fontSize: "var(--text-body)" }}>
            {t("settings.account.mfa.not_enrolled_body")}
          </p>
          <Button type="button" disabled={busy} onClick={() => { void handleStart(); }}>
            {t("settings.account.mfa.setup_action")}
          </Button>
        </div>
      ) : null}

      {enrolData ? (
        <div className="flex flex-col gap-sp-6">
          <div className="flex justify-center">
            <div className="rounded-lg border border-[color:var(--border)] bg-white p-sp-3">
              <img
                src={enrolData.qrDataUri}
                alt={t("settings.account.mfa.qr_alt")}
                width={180}
                height={180}
              />
            </div>
          </div>
          <div className="flex flex-col gap-sp-2">
            <Label>{t("settings.account.mfa.secret_label")}</Label>
            <code
              className="rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 break-all text-fg"
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}
            >
              {enrolData.textSecret}
            </code>
          </div>
          <div className="flex flex-col gap-sp-2">
            <Label>{t("settings.account.mfa.confirm_label")}</Label>
            <TotpInput value={totpCode} onChange={setTotpCode} disabled={busy} />
          </div>
          <div className="flex gap-sp-4">
            <Button
              type="button"
              disabled={busy || totpCode.replace(/\D/g, "").length < 6}
              onClick={() => { void handleConfirm(); }}
            >
              {t("settings.account.mfa.confirm_action")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => { setEnrolData(null); setTotpCode(""); }}
            >
              {t("settings.account.cancel_action")}
            </Button>
          </div>
        </div>
      ) : null}

      {account.mfaState === "enrolled" ? (
        <div className="flex flex-col gap-sp-6">
          <div className="flex flex-col gap-sp-1">
            <p className="m-0 font-medium text-fg" style={{ fontSize: "var(--text-body)" }}>
              {t("settings.account.mfa.enrolled_title")}
            </p>
            {account.remainingBackupCodes != null ? (
              <p className="m-0 text-fg-subtle" style={{ fontSize: "var(--text-small)" }}>
                {t("settings.account.mfa.backup_codes_remaining", {
                  count: String(account.remainingBackupCodes),
                })}
              </p>
            ) : null}
          </div>

          {showRegenerate ? (
            <div className="flex flex-col gap-sp-4">
              <Label htmlFor="mfa-regenerate-code">
                {t("settings.account.mfa.verify_label")}
              </Label>
              <Input
                id="mfa-regenerate-code"
                value={actionCode}
                onChange={(event) => { setActionCode(event.target.value); }}
              />
              <div className="flex gap-sp-4">
                <Button
                  type="button"
                  disabled={busy || !actionCode.trim()}
                  onClick={() => { void handleRegenerate(); }}
                >
                  {t("settings.account.mfa.regenerate_confirm")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => { setShowRegenerate(false); setActionCode(""); }}
                >
                  {t("settings.account.cancel_action")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-sp-4">
              <Button type="button" variant="secondary" onClick={() => { setShowRegenerate(true); }}>
                {t("settings.account.mfa.regenerate_action")}
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-sp-4 border-t border-[color:var(--border-subtle)] pt-sp-5">
            <Label htmlFor="mfa-disable-code">
              {t("settings.account.mfa.disable_label")}
            </Label>
            <Input
              id="mfa-disable-code"
              value={actionCode}
              onChange={(event) => { setActionCode(event.target.value); }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !actionCode.trim()}
              onClick={() => { void handleDisable(); }}
            >
              {t("settings.account.mfa.disable_action")}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
