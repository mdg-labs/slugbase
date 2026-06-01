import { useTranslate } from "@tolgee/react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { applyUserAccentColor } from "../account-accent.js";
import {
  confirmMfaEnrol,
  createApiToken,
  disableMfa,
  regenerateMfaBackupCodes,
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
  const { t } = useTranslate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [account, setAccount] = useState(initialAccount);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const section = (searchParams.get("section") as AccountSectionId | null) ?? "profile";
  const validSection = SECTIONS.includes(section) ? section : "profile";

  const setSection = (next: AccountSectionId) => {
    setSearchParams(next === "profile" ? {} : { section: next });
  };

  const showToast = (messageKey: string, params?: Record<string, string>) => {
    setStatusMessage(t(messageKey, params));
    setErrorMessage(null);
  };

  const showError = (message: string) => {
    setErrorMessage(message);
    setStatusMessage(null);
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
      <header className="mb-sp-7">
        <h1
          className="m-0 text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("settings.account.page_title")}
        </h1>
        <p
          className="mt-sp-2 m-0 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("settings.account.page_subtitle")}
        </p>
      </header>

      {statusMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--success-subtle)] bg-[color:var(--success-subtle)] px-sp-4 py-sp-3 text-success-text"
          role="status"
          style={{ fontSize: "var(--text-small)" }}
        >
          {statusMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3 text-danger-text"
          role="alert"
          style={{ fontSize: "var(--text-small)" }}
        >
          {errorMessage}
        </p>
      ) : null}

      <nav
        className="mb-sp-7 flex flex-wrap gap-sp-2 border-b border-[color:var(--border-subtle)]"
        aria-label={t("settings.account.nav_label")}
      >
        {SECTIONS.map((sectionId) => (
          <button
            key={sectionId}
            type="button"
            onClick={() => { setSection(sectionId); }}
            className={`-mb-px border-b-2 px-sp-4 py-sp-3 font-medium transition-colors ${
              validSection === sectionId
                ? "border-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
            style={{ fontSize: "var(--text-body)" }}
          >
            {t(`settings.account.tab_${sectionId}`)}
          </button>
        ))}
      </nav>

      {validSection === "profile" ? (
        <ProfileSection
          account={account}
          t={t}
          onSave={async (name) => {
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
