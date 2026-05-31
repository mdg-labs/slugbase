import { Button, Input, Label } from "@slugbase/ui";
import { useState } from "react";

import type { AccountSettingsData } from "../account.types.js";
import { SettingsSection } from "./SettingsSection.js";

interface PasswordSectionProps {
  account: AccountSettingsData;
  onSave: (payload: { currentPassword?: string; newPassword: string }) => Promise<void>;
  t: (key: string) => string;
}

export function PasswordSection({ account, onSave, t }: PasswordSectionProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const match = newPassword.length > 0 && newPassword === confirmPassword;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit =
    newPassword.length >= 12 &&
    match &&
    (account.hasPassword ? currentPassword.length > 0 : true);

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSave({
        currentPassword: account.hasPassword ? currentPassword : undefined,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      titleKey="settings.account.password.title"
      descriptionKey="settings.account.password.description"
      t={t}
    >
      {!account.hasPassword ? (
        <div
          className="rounded-md border border-[color:var(--border-subtle)] bg-raised px-sp-4 py-sp-4 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("settings.account.password.federated_notice")}
        </div>
      ) : null}

      {account.hasPassword ? (
        <div className="flex flex-col gap-sp-2">
          <Label htmlFor="current-password">
            {t("settings.account.password.current_label")}
          </Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => { setCurrentPassword(event.target.value); }}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-sp-2">
        <Label htmlFor="new-password">{t("settings.account.password.new_label")}</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => { setNewPassword(event.target.value); }}
        />
      </div>

      <div className="flex flex-col gap-sp-2">
        <Label htmlFor="confirm-password">
          {t("settings.account.password.confirm_label")}
        </Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => { setConfirmPassword(event.target.value); }}
          aria-invalid={mismatch}
        />
        {mismatch ? (
          <p className="m-0 text-danger-text" style={{ fontSize: "var(--text-small)" }}>
            {t("settings.account.password.mismatch_error")}
          </p>
        ) : null}
        {match ? (
          <p className="m-0 text-success-text" style={{ fontSize: "var(--text-small)" }}>
            {t("settings.account.password.match_hint")}
          </p>
        ) : null}
      </div>

      <div>
        <Button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() => { void handleSubmit(); }}
        >
          {busy
            ? t("settings.account.password.submit_loading")
            : account.hasPassword
              ? t("settings.account.password.submit_update")
              : t("settings.account.password.submit_add")}
        </Button>
      </div>
    </SettingsSection>
  );
}
