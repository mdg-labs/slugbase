import { Input, Label } from "@slugbase/ui";
import { useEffect, useState } from "react";

import type { AccountSettingsData } from "../account.types.js";
import { SaveBar, SettingsSection } from "./SettingsSection.js";

interface ProfileSectionProps {
  account: AccountSettingsData;
  onSaveName: (name: string) => Promise<void>;
  onRequestEmailChange: (email: string) => Promise<void>;
  onResendEmailChange: () => Promise<void>;
  onCancelEmailChange: () => Promise<void>;
  t: (key: string, params?: Record<string, string>) => string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProfileSection({
  account,
  onSaveName,
  onRequestEmailChange,
  onResendEmailChange,
  onCancelEmailChange,
  t,
}: ProfileSectionProps) {
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [busy, setBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);

  const nameDirty = name.trim() !== account.name;
  const emailDirty =
    !account.pendingEmail &&
    email.trim().toLowerCase() !== account.email.toLowerCase();

  useEffect(() => {
    setName(account.name);
    setEmail(account.email);
  }, [account.name, account.email, account.pendingEmail]);

  const handleSaveName = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSaveName(name.trim());
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEmail = async (): Promise<void> => {
    setEmailBusy(true);
    try {
      await onRequestEmailChange(email.trim());
    } finally {
      setEmailBusy(false);
    }
  };

  const handleDiscard = (): void => {
    setName(account.name);
    setEmail(account.email);
  };

  return (
    <SettingsSection
      titleKey="settings.account.profile.title"
      descriptionKey="settings.account.profile.description"
      t={t}
    >
      <div className="flex items-center gap-sp-6">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-fg"
          style={{ fontSize: "var(--text-h3)" }}
          aria-hidden="true"
        >
          {initials(name || account.name)}
        </div>
        <p
          className="m-0 text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("settings.account.profile.avatar_hint")}
        </p>
      </div>

      <div className="flex flex-col gap-sp-2">
        <Label htmlFor="account-name">{t("settings.account.profile.name_label")}</Label>
        <Input
          id="account-name"
          value={name}
          onChange={(event) => { setName(event.target.value); }}
        />
      </div>

      <div className="flex flex-col gap-sp-3">
        <Label htmlFor="account-email">{t("settings.account.profile.email_label")}</Label>

        {account.pendingEmail ? (
          <div
            className="rounded-md border border-[color:var(--warning-subtle)] bg-[color:var(--warning-subtle)] px-sp-4 py-sp-4"
            style={{ fontSize: "var(--text-small)" }}
          >
            <p className="m-0 font-medium text-fg">
              {t("settings.account.profile.email_pending_title")}
            </p>
            <p className="mt-sp-2 mb-0 text-fg-muted">
              {t("settings.account.profile.email_pending_body", {
                email: account.pendingEmailMasked ?? account.pendingEmail,
              })}
            </p>
            <div className="mt-sp-4 flex flex-wrap gap-sp-4">
              <button
                type="button"
                className="text-accent-text hover:underline"
                disabled={emailBusy}
                onClick={() => { void onResendEmailChange(); }}
              >
                {t("settings.account.profile.email_resend_action")}
              </button>
              <button
                type="button"
                className="text-fg-subtle hover:text-fg hover:underline"
                disabled={emailBusy}
                onClick={() => { void onCancelEmailChange(); }}
              >
                {t("settings.account.profile.email_cancel_action")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(event) => { setEmail(event.target.value); }}
              autoComplete="email"
            />
            <p
              className="m-0 text-fg-subtle"
              style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
            >
              {t("settings.account.profile.email_hint")}
            </p>
            {emailDirty ? (
              <div className="flex flex-wrap gap-sp-3">
                <button
                  type="button"
                  className="rounded-md border border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] px-sp-4 py-sp-3 font-medium text-accent-text"
                  disabled={emailBusy}
                  onClick={() => { void handleSaveEmail(); }}
                >
                  {emailBusy
                    ? t("settings.account.save_loading")
                    : t("settings.account.profile.email_save_action")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <SaveBar
        dirty={nameDirty}
        busy={busy}
        onSave={() => { void handleSaveName(); }}
        onDiscard={handleDiscard}
        t={t}
      />
    </SettingsSection>
  );
}
