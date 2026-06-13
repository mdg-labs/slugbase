import type { ReactNode } from "react";

interface SettingsSectionProps {
  titleKey: string;
  descriptionKey: string;
  t: (key: string) => string;
  children: ReactNode;
}

export function SettingsSection({
  titleKey,
  descriptionKey,
  t,
  children,
}: SettingsSectionProps) {
  return (
    <section className="flex flex-col gap-sp-6 rounded-lg border border-[color:var(--border-subtle)] bg-base p-sp-6">
      <div>
        <h2
          className="m-0 text-fg font-semibold"
          style={{ fontSize: "var(--text-h3)", lineHeight: "var(--lh-h3)" }}
        >
          {t(titleKey)}
        </h2>
        <p
          className="mt-sp-2 m-0 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t(descriptionKey)}
        </p>
      </div>
      {children}
    </section>
  );
}

interface SaveBarProps {
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  t: (key: string) => string;
}

export function SaveBar({ dirty, busy, onSave, onDiscard, t }: SaveBarProps) {
  if (!dirty) return null;
  return (
    <div className="flex items-center gap-sp-4 border-t border-[color:var(--border-subtle)] pt-sp-5">
      <button
        type="button"
        disabled={busy}
        onClick={onSave}
        className="rounded-md bg-accent px-sp-5 py-sp-3 font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        style={{ fontSize: "var(--text-body)" }}
      >
        {busy ? t("settings.account.save_loading") : t("settings.account.save_action")}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDiscard}
        className="rounded-md border border-[color:var(--border)] bg-raised px-sp-5 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2 disabled:opacity-50"
        style={{ fontSize: "var(--text-body)" }}
      >
        {t("settings.account.discard_action")}
      </button>
    </div>
  );
}
