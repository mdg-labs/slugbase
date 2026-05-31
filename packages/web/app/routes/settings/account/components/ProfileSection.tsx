import { Input, Label } from "@slugbase/ui";
import { useEffect, useState } from "react";

import type { AccountSettingsData } from "../account.types.js";
import { SaveBar, SettingsSection } from "./SettingsSection.js";

interface ProfileSectionProps {
  account: AccountSettingsData;
  onSave: (name: string) => Promise<void>;
  t: (key: string) => string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProfileSection({ account, onSave, t }: ProfileSectionProps) {
  const [name, setName] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== account.name;

  useEffect(() => {
    setName(account.name);
  }, [account.name]);

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSave(name.trim());
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = (): void => {
    setName(account.name);
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

      <div className="flex flex-col gap-sp-2">
        <Label htmlFor="account-email">{t("settings.account.profile.email_label")}</Label>
        <Input id="account-email" value={account.email} readOnly disabled />
        <p
          className="m-0 text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("settings.account.profile.email_hint")}
        </p>
      </div>

      <SaveBar
        dirty={dirty}
        busy={busy}
        onSave={() => { void handleSave(); }}
        onDiscard={handleDiscard}
        t={t}
      />
    </SettingsSection>
  );
}
