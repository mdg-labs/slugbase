import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useAppToast } from "../../../../components/feedback/AppToastProvider.js";

import { applyUserAccentColor } from "../account-accent.js";
import {
  cancelAccountEmailChange,
  confirmMfaEnrol,
  createApiToken,
  disableMfa,
  regenerateMfaBackupCodes,
  requestAccountEmailChange,
  resendAccountEmailChange,
  revokeApiToken,
  startMfaEnrol,
  updateAccountPassword,
  updateAccountPreferences,
  updateAccountProfile,
} from "../account-api.js";
import type { AccountSectionId, AccountSettingsData, ApiTokenSummary } from "../account.types.js";
import { ApiTokensSection } from "./ApiTokensSection.js";
import { MfaSection } from "./MfaSection.js";
import { PasswordSection } from "./PasswordSection.js";
import { PreferencesSection } from "./PreferencesSection.js";
import { ProfileSection } from "./ProfileSection.js";

const SECTIONS: AccountSectionId[] = [
  "profile",
  "password",
  "mfa",
  "tokens",
  "preferences",
];

export interface AccountSettingsPageProps {
  initialAccount: AccountSettingsData;
  initialTokens: ApiTokenSummary[];
}

export function AccountSettingsPage({
  initialAccount,
  initialTokens,
}: AccountSettingsPageProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [account, setAccount] = useState(initialAccount);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { showToast } = useAppToast();

  const section = (searchParams.get("section") as AccountSectionId | null) ?? "profile";
  const validSection = SECTIONS.includes(section) ? section : "profile";

  const showError = (message: string) => {
    setErrorMessage(message);
  };

  const refreshAccount = useMemo(
    () => () => {
      void fetch(`${process.env["API_BASE_URL"] ?? ""}/auth/account`, {
        credentials: "include",
      })
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as AccountSettingsData;
          setAccount(data);
          applyUserAccentColor(data.accentColor);
        })
        .catch(() => undefined);
    },
    [],
  );

  return (
    <div className="mx-auto max-w-[680px] px-sp-6 py-sp-8" data-testid="account-settings-page">
      {errorMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3 text-danger-text"
          role="alert"
          style={{ fontSize: "var(--text-small)" }}
        >
          {errorMessage}
        </p>
      ) : null}

      {validSection === "profile" ? (
        <ProfileSection
          account={account}
          t={(key: string, params?: Record<string, string>) => t(key, params)}
          onSaveName={async (name) => {
            try {
              const updated = await updateAccountProfile({ name });
              setAccount(updated);
              showToast("settings.account.profile.toast_saved");
            } catch (err) {
              showError(
                err instanceof Error ? err.message : t("settings.account.error_generic"),
              );
            }
          }}
          onRequestEmailChange={async (email) => {
            try {
              const updated = await requestAccountEmailChange({ email });
              setAccount(updated);
              showToast("settings.account.profile.email_toast_requested");
            } catch (err) {
              showError(
                err instanceof Error ? err.message : t("settings.account.error_generic"),
              );
            }
          }}
          onResendEmailChange={async () => {
            try {
              await resendAccountEmailChange();
              showToast("settings.account.profile.email_toast_resent");
            } catch (err) {
              showError(
                err instanceof Error ? err.message : t("settings.account.error_generic"),
              );
            }
          }}
          onCancelEmailChange={async () => {
            try {
              const updated = await cancelAccountEmailChange();
              setAccount(updated);
              showToast("settings.account.profile.email_toast_cancelled");
            } catch (err) {
              showError(
                err instanceof Error ? err.message : t("settings.account.error_generic"),
              );
            }
          }}
        />
      ) : null}

      {validSection === "password" ? (
        <PasswordSection
          account={account}
          t={t}
          onSave={async (payload) => {
            try {
              await updateAccountPassword(payload);
              setAccount((current: AccountSettingsData) => ({ ...current, hasPassword: true }));
              showToast("settings.account.password.toast_saved");
            } catch (err) {
              showError(
                err instanceof Error ? err.message : t("settings.account.error_generic"),
              );
            }
          }}
        />
      ) : null}

      {validSection === "mfa" ? (
        <MfaSection
          account={account}
          t={(key: string, params?: Record<string, string>) => t(key, params)}
          onStartEnrol={startMfaEnrol}
          onConfirmEnrol={confirmMfaEnrol}
          onDisable={disableMfa}
          onRegenerate={regenerateMfaBackupCodes}
          onAccountRefresh={refreshAccount}
        />
      ) : null}

      {validSection === "tokens" ? (
        <ApiTokensSection
          tokens={initialTokens}
          t={(key: string, params?: Record<string, string>) => t(key, params)}
          onCreate={createApiToken}
          onRevoke={async (id) => {
            await revokeApiToken(id);
            showToast("settings.account.tokens.toast_revoked");
          }}
        />
      ) : null}

      {validSection === "preferences" ? (
        <PreferencesSection
          account={account}
          t={t}
          onSave={async (payload) => {
            try {
              const updated = await updateAccountPreferences(payload);
              setAccount(updated);
              showToast("settings.account.prefs.toast_saved");
            } catch (err) {
              showError(
                err instanceof Error ? err.message : t("settings.account.error_generic"),
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}
