import { useTheme, type ThemePreference } from "@slugbase/ui";
import { useEffect, useState } from "react";

import { ACCENT_PRESET_LABEL_KEYS, applyUserAccentColor } from "../account-accent.js";
import {
  ALLOWED_ACCENT_COLORS,
  type AccountSettingsData,
  type AllowedAccentColor,
} from "../account.types.js";
import { SaveBar, SettingsSection } from "./SettingsSection.js";

interface PreferencesSectionProps {
  account: AccountSettingsData;
  onSave: (payload: {
    language: "en" | "de";
    theme: ThemePreference;
    accentColor: AllowedAccentColor | null;
    aiOptOut: boolean;
  }) => Promise<void>;
  t: (key: string) => string;
}

const THEME_OPTIONS: ThemePreference[] = ["dark", "light", "auto"];

export function PreferencesSection({ account, onSave, t }: PreferencesSectionProps) {
  const { setPreference } = useTheme();
  const [language, setLanguage] = useState(account.language);
  const [theme, setTheme] = useState<ThemePreference>(account.theme);
  const [accentColor, setAccentColor] = useState(account.accentColor);
  const [aiOptOut, setAiOptOut] = useState(account.aiOptOut);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLanguage(account.language);
    setTheme(account.theme);
    setAccentColor(account.accentColor);
    setAiOptOut(account.aiOptOut);
  }, [account.language, account.theme, account.accentColor, account.aiOptOut]);

  const dirty =
    language !== account.language ||
    theme !== account.theme ||
    accentColor !== account.accentColor ||
    aiOptOut !== account.aiOptOut;

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSave({ language, theme, accentColor, aiOptOut });
      setPreference(theme);
      applyUserAccentColor(accentColor);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = (): void => {
    setLanguage(account.language);
    setTheme(account.theme);
    setAccentColor(account.accentColor);
    setAiOptOut(account.aiOptOut);
  };

  return (
    <SettingsSection
      titleKey="settings.account.prefs.title"
      descriptionKey="settings.account.prefs.description"
      t={t}
    >
      <div className="flex flex-col gap-sp-2">
        <label
          htmlFor="pref-language"
          className="font-medium text-fg-muted"
          style={{ fontSize: "var(--text-small)" }}
        >
          {t("settings.account.prefs.language_label")}
        </label>
        <select
          id="pref-language"
          className="w-full max-w-xs rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg"
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as "en" | "de");
          }}
        >
          <option value="en">{t("settings.account.prefs.language_en")}</option>
          <option value="de">{t("settings.account.prefs.language_de")}</option>
        </select>
      </div>

      <div className="flex flex-col gap-sp-3">
        <span
          className="font-medium text-fg-muted"
          style={{ fontSize: "var(--text-small)" }}
        >
          {t("settings.account.prefs.theme_label")}
        </span>
        <div className="flex flex-wrap gap-sp-3">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => { setTheme(option); }}
              className={`rounded-md border px-sp-5 py-sp-3 font-medium transition-colors ${
                theme === option
                  ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-accent-text"
                  : "border-[color:var(--border)] bg-raised text-fg hover:bg-raised-2"
              }`}
              style={{ fontSize: "var(--text-body)" }}
            >
              {t(`settings.account.prefs.theme_${option}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-sp-3">
        <span
          className="font-medium text-fg-muted"
          style={{ fontSize: "var(--text-small)" }}
        >
          {t("settings.account.prefs.accent_label")}
        </span>
        <div className="flex flex-wrap gap-sp-3">
          <button
            type="button"
            aria-pressed={accentColor === null}
            onClick={() => { setAccentColor(null); }}
            className={`flex items-center gap-sp-3 rounded-md border px-sp-4 py-sp-3 ${
              accentColor === null
                ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)]"
                : "border-[color:var(--border)] bg-raised"
            }`}
          >
            <span
              className="h-8 w-8 rounded-md border border-[color:var(--border)] bg-[linear-gradient(135deg,#7782f7,#5b66e8)]"
              aria-hidden="true"
            />
            <span style={{ fontSize: "var(--text-small)" }}>
              {t("settings.account.prefs.accent_default")}
            </span>
          </button>
          {ALLOWED_ACCENT_COLORS.map((hex: AllowedAccentColor) => (
            <button
              key={hex}
              type="button"
              aria-pressed={accentColor === hex}
              aria-label={t(ACCENT_PRESET_LABEL_KEYS[hex])}
              onClick={() => { setAccentColor(hex); }}
              className={`h-10 w-10 rounded-md border-2 ${
                accentColor === hex
                  ? "border-[color:var(--accent-border)]"
                  : "border-transparent"
              }`}
              style={{ background: hex }}
            />
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-sp-3">
        <input
          type="checkbox"
          checked={aiOptOut}
          onChange={(event) => { setAiOptOut(event.target.checked); }}
          className="mt-0.5 h-4 w-4 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
        />
        <span className="flex flex-col gap-sp-1">
          <span className="font-medium text-fg" style={{ fontSize: "var(--text-body)" }}>
            {t("settings.account.prefs.ai_opt_out_label")}
          </span>
          <span className="text-fg-subtle" style={{ fontSize: "var(--text-small)" }}>
            {t("settings.account.prefs.ai_opt_out_hint")}
          </span>
        </span>
      </label>

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
