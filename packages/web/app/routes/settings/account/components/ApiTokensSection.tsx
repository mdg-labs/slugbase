import { Button, Input, Label } from "@slugbase/ui";
import { useState } from "react";

import type { ApiTokenSummary } from "../account.types.js";
import { ShownOncePanel } from "./ShownOncePanel.js";
import { SettingsSection } from "./SettingsSection.js";

interface ApiTokensSectionProps {
  tokens: ApiTokenSummary[];
  onCreate: (name: string) => Promise<{ token: ApiTokenSummary; plaintext: string }>;
  onRevoke: (id: string) => Promise<void>;
  t: (key: string, params?: Record<string, string>) => string;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}

export function ApiTokensSection({
  tokens,
  onCreate,
  onRevoke,
  t,
}: ApiTokensSectionProps) {
  const [items, setItems] = useState(tokens);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const locale = "en";

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const result = await onCreate(name.trim());
      setItems((current) => [...current, result.token]);
      setPlaintext(result.plaintext);
      setCreating(false);
      setName("");
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string): Promise<void> => {
    setRevokingId(id);
    try {
      await onRevoke(id);
      setItems((current) => current.filter((token) => token.id !== id));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <SettingsSection
      titleKey="settings.account.tokens.title"
      descriptionKey="settings.account.tokens.description"
      t={t}
    >
      {items.length === 0 && !creating ? (
        <p className="m-0 text-center text-fg-subtle" style={{ fontSize: "var(--text-body)" }}>
          {t("settings.account.tokens.empty")}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)]">
          {items.map((token) => (
            <div
              key={token.id}
              className="flex flex-wrap items-center gap-sp-4 border-b border-[color:var(--border-subtle)] bg-raised px-sp-5 py-sp-4 last:border-b-0"
            >
              <span className="font-medium text-fg">{token.name}</span>
              <span className="text-fg-subtle" style={{ fontSize: "var(--text-small)" }}>
                {t("settings.account.tokens.created_meta", {
                  date: formatDate(token.createdAt, locale),
                })}
              </span>
              <span className="text-fg-subtle" style={{ fontSize: "var(--text-small)" }}>
                {t("settings.account.tokens.last_used_meta", {
                  date: token.lastUsedAt
                    ? formatDate(token.lastUsedAt, locale)
                    : t("settings.account.tokens.never_used"),
                })}
              </span>
              <Button
                type="button"
                variant="secondary"
                disabled={revokingId === token.id}
                onClick={() => { void handleRevoke(token.id); }}
              >
                {t("settings.account.tokens.revoke_action")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {plaintext ? (
        <ShownOncePanel
          values={[plaintext]}
          labelKey="settings.account.tokens.shown_once_label"
          warningKey="settings.account.tokens.shown_once_warning"
          copyActionKey="settings.account.tokens.shown_once_copy"
          copiedKey="settings.account.tokens.shown_once_copied"
          t={t}
        />
      ) : null}

      {creating ? (
        <div className="flex flex-wrap items-end gap-sp-4">
          <div className="min-w-[240px] flex-1">
            <Label htmlFor="token-name">{t("settings.account.tokens.name_label")}</Label>
            <Input
              id="token-name"
              value={name}
              onChange={(event) => { setName(event.target.value); }}
              placeholder={t("settings.account.tokens.name_placeholder")}
            />
          </div>
          <Button type="button" disabled={busy || !name.trim()} onClick={() => { void handleCreate(); }}>
            {t("settings.account.tokens.create_action")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => { setCreating(false); setName(""); }}
          >
            {t("settings.account.cancel_action")}
          </Button>
        </div>
      ) : (
        <Button type="button" variant="secondary" onClick={() => { setCreating(true); }}>
          {t("settings.account.tokens.new_action")}
        </Button>
      )}
    </SettingsSection>
  );
}
