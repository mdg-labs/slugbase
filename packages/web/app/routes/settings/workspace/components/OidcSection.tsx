import { Input, Label } from "@slugbase/ui";
import { useState } from "react";

import type { OidcProviderSummary } from "../workspace.types.js";
import { SettingsSection } from "../../account/components/SettingsSection.js";

interface OidcSectionProps {
  providers: OidcProviderSummary[];
  appBaseUrl: string;
  onCreate: (payload: {
    name: string;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    enabled: boolean;
  }) => Promise<void>;
  onToggle: (providerId: string, enabled: boolean) => Promise<void>;
  onDelete: (providerId: string) => Promise<void>;
  t: (key: string) => string;
}

interface NewProviderForm {
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

const emptyForm = (): NewProviderForm => ({
  name: "",
  issuerUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid email profile",
});

export function OidcSection({
  providers,
  appBaseUrl,
  onCreate,
  onToggle,
  onDelete,
  t,
}: OidcSectionProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<NewProviderForm>(emptyForm);
  const [busy, setBusy] = useState(false);

  const callbackTemplate = `${appBaseUrl}/auth/oidc/{providerId}/callback`;

  const handleCreate = async (): Promise<void> => {
    setBusy(true);
    try {
      await onCreate({
        ...form,
        enabled: true,
      });
      setForm(emptyForm());
      setAddOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      titleKey="settings.workspace.oidc.title"
      descriptionKey="settings.workspace.oidc.description"
      t={t}
    >
      {providers.length > 0 ? (
        <ul className="m-0 list-none divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border-subtle)] bg-raised p-0">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex flex-wrap items-center gap-sp-3 px-sp-4 py-sp-4"
            >
              <span
                className="font-medium text-fg"
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}
              >
                {provider.name}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-fg-muted"
                style={{ fontSize: "var(--text-small)" }}
              >
                {provider.clientId}
              </span>
              <span
                className={`rounded px-sp-2 py-sp-1 font-medium ${
                  provider.enabled
                    ? "bg-[color:var(--success-subtle)] text-success-text"
                    : "bg-[color:var(--border-subtle)] text-fg-subtle"
                }`}
                style={{ fontSize: "var(--text-small)" }}
              >
                {provider.enabled
                  ? t("settings.workspace.oidc.status_enabled")
                  : t("settings.workspace.oidc.status_disabled")}
              </span>
              <button
                type="button"
                onClick={() => { void onToggle(provider.id, !provider.enabled); }}
                className="rounded-md border border-[color:var(--border)] bg-base px-sp-3 py-sp-2 text-fg"
                style={{ fontSize: "var(--text-small)" }}
              >
                {provider.enabled
                  ? t("settings.workspace.oidc.disable_action")
                  : t("settings.workspace.oidc.enable_action")}
              </button>
              <button
                type="button"
                onClick={() => { void onDelete(provider.id); }}
                className="rounded-md border border-[color:var(--danger-border)] px-sp-3 py-sp-2 text-danger-text"
                style={{ fontSize: "var(--text-small)" }}
              >
                {t("settings.workspace.oidc.delete_action")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-fg-subtle" style={{ fontSize: "var(--text-body)" }}>
          {t("settings.workspace.oidc.empty")}
        </p>
      )}

      {!addOpen ? (
        <button
          type="button"
          onClick={() => { setAddOpen(true); }}
          className="rounded-md border border-[color:var(--border)] bg-raised px-sp-5 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2"
          style={{ fontSize: "var(--text-body)" }}
        >
          {t("settings.workspace.oidc.add_action")}
        </button>
      ) : (
        <div className="flex flex-col gap-sp-5 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
          <h3
            className="m-0 font-semibold text-fg"
            style={{ fontSize: "var(--text-body-lg)" }}
          >
            {t("settings.workspace.oidc.add_heading")}
          </h3>
          <div className="flex flex-col gap-sp-2">
            <Label>{t("settings.workspace.oidc.callback_label")}</Label>
            <code
              className="block break-all rounded-md border border-[color:var(--border)] bg-base px-sp-3 py-sp-2 text-fg-muted"
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}
            >
              {callbackTemplate}
            </code>
            <p
              className="m-0 text-fg-subtle"
              style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
            >
              {t("settings.workspace.oidc.callback_hint")}
            </p>
          </div>
          <div className="grid gap-sp-5 sm:grid-cols-2">
            <div className="flex flex-col gap-sp-2">
              <Label htmlFor="oidc-name">{t("settings.workspace.oidc.name_label")}</Label>
              <Input
                id="oidc-name"
                value={form.name}
                onChange={(event) => { setForm((prev) => ({ ...prev, name: event.target.value })); }}
              />
            </div>
            <div className="flex flex-col gap-sp-2">
              <Label htmlFor="oidc-client-id">{t("settings.workspace.oidc.client_id_label")}</Label>
              <Input
                id="oidc-client-id"
                value={form.clientId}
                onChange={(event) => {
                  setForm((prev) => ({ ...prev, clientId: event.target.value }));
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-sp-2">
            <Label htmlFor="oidc-secret">{t("settings.workspace.oidc.client_secret_label")}</Label>
            <Input
              id="oidc-secret"
              type="password"
              value={form.clientSecret}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, clientSecret: event.target.value }));
              }}
            />
          </div>
          <div className="flex flex-col gap-sp-2">
            <Label htmlFor="oidc-issuer">{t("settings.workspace.oidc.issuer_label")}</Label>
            <Input
              id="oidc-issuer"
              value={form.issuerUrl}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, issuerUrl: event.target.value }));
              }}
            />
          </div>
          <div className="flex flex-col gap-sp-2">
            <Label htmlFor="oidc-scopes">{t("settings.workspace.oidc.scopes_label")}</Label>
            <Input
              id="oidc-scopes"
              value={form.scopes}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, scopes: event.target.value }));
              }}
            />
          </div>
          <div className="flex flex-wrap gap-sp-3">
            <button
              type="button"
              disabled={
                busy ||
                !form.name.trim() ||
                !form.clientId.trim() ||
                !form.clientSecret.trim() ||
                !form.issuerUrl.trim()
              }
              onClick={() => { void handleCreate(); }}
              className="rounded-md bg-accent px-sp-5 py-sp-3 font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
              style={{ fontSize: "var(--text-body)" }}
            >
              {t("settings.workspace.oidc.add_submit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setForm(emptyForm());
              }}
              className="rounded-md border border-[color:var(--border)] bg-base px-sp-5 py-sp-3 font-medium text-fg"
              style={{ fontSize: "var(--text-body)" }}
            >
              {t("settings.account.cancel_action")}
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
