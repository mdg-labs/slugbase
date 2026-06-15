import { Input, Label } from "@slugbase/ui";
import { useEffect, useState } from "react";

import type { AiSettingsData, WorkspaceInterfaceConfig } from "../workspace.types.js";
import { SaveBar, SettingsSection } from "../../account/components/SettingsSection.js";

interface AiSectionProps {
  initial: AiSettingsData;
  interfaceConfig: WorkspaceInterfaceConfig;
  onSave: (payload: { enabled: boolean; apiKey?: string; model?: string }) => Promise<void>;
  t: (key: string) => string;
}

const defaultAi: AiSettingsData = {
  enabled: false,
  hasApiKey: false,
  model: "gpt-4o-mini",
};

export function AiSection({ initial, interfaceConfig, onSave, t }: AiSectionProps) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(initial.enabled);
    setModel(initial.model);
    setApiKey("");
  }, [initial]);

  const dirty =
    enabled !== initial.enabled ||
    model !== initial.model ||
    apiKey.length > 0;

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSave({
        enabled,
        model,
        ...(interfaceConfig.aiByoCredential && apiKey.length > 0 ? { apiKey } : {}),
      });
      setApiKey("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      titleKey="settings.workspace.ai.title"
      descriptionKey="settings.workspace.ai.description"
      t={t}
    >
      <label className="flex cursor-pointer items-start gap-sp-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => { setEnabled(event.target.checked); }}
          className="mt-0.5 h-4 w-4 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
        />
        <span className="flex flex-col gap-sp-1">
          <span className="font-medium text-fg" style={{ fontSize: "var(--text-body)" }}>
            {t("settings.workspace.ai.enable_label")}
          </span>
          <span className="text-fg-subtle" style={{ fontSize: "var(--text-small)" }}>
            {t("settings.workspace.ai.enable_hint")}
          </span>
        </span>
      </label>

      {enabled && !interfaceConfig.aiByoCredential ? (
        <p
          className="m-0 rounded-md border border-[color:var(--border-subtle)] bg-raised px-sp-4 py-sp-3 text-fg-muted"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("settings.workspace.ai.hosted_operator_notice")}
        </p>
      ) : null}

      {interfaceConfig.aiByoCredential ? (
        <>
          <div className="flex flex-col gap-sp-2">
            <Label htmlFor="ai-api-key">{t("settings.workspace.ai.api_key_label")}</Label>
            <Input
              id="ai-api-key"
              type="password"
              value={apiKey}
              placeholder={
                initial.hasApiKey
                  ? t("settings.workspace.ai.api_key_placeholder_set")
                  : t("settings.workspace.ai.api_key_placeholder_empty")
              }
              onChange={(event) => { setApiKey(event.target.value); }}
            />
            <p
              className="m-0 text-fg-subtle"
              style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
            >
              {t("settings.workspace.ai.api_key_hint")}
            </p>
          </div>
          <div className="flex flex-col gap-sp-2">
            <Label htmlFor="ai-model">{t("settings.workspace.ai.model_label")}</Label>
            <select
              id="ai-model"
              className="w-full max-w-sm rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-3 text-fg"
              value={model}
              onChange={(event) => { setModel(event.target.value); }}
            >
              <option value="gpt-4o-mini">{t("settings.workspace.ai.model_gpt4o_mini")}</option>
              <option value="gpt-4o">{t("settings.workspace.ai.model_gpt4o")}</option>
            </select>
          </div>
        </>
      ) : null}

      <SaveBar
        dirty={dirty}
        busy={busy}
        onSave={() => { void handleSave(); }}
        onDiscard={() => {
          setEnabled(initial.enabled);
          setModel(initial.model);
          setApiKey("");
        }}
        t={t}
      />
    </SettingsSection>
  );
}

export { defaultAi };
