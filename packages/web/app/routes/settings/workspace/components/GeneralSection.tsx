import { Input, Label } from "@slugbase/ui";
import { useEffect, useState } from "react";

import type { WorkspaceSummary } from "../workspace.types.js";
import { SaveBar, SettingsSection } from "../../account/components/SettingsSection.js";

interface GeneralSectionProps {
  workspace: WorkspaceSummary;
  onSaveName: (name: string) => Promise<void>;
  onDeleteWorkspace: () => Promise<void>;
  t: (key: string, params?: Record<string, string>) => string;
}

export function GeneralSection({
  workspace,
  onSaveName,
  onDeleteWorkspace,
  t,
}: GeneralSectionProps) {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const dirty = name.trim() !== workspace.name;

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.name]);

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSaveName(name.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      titleKey="settings.workspace.general.title"
      descriptionKey="settings.workspace.general.description"
      t={t}
    >
      <div className="flex flex-col gap-sp-2">
        <Label htmlFor="workspace-name">{t("settings.workspace.general.name_label")}</Label>
        <Input
          id="workspace-name"
          value={name}
          onChange={(event) => { setName(event.target.value); }}
        />
      </div>

      <SaveBar
        dirty={dirty}
        busy={busy}
        onSave={() => { void handleSave(); }}
        onDiscard={() => { setName(workspace.name); }}
        t={t}
      />

      <div className="border-t border-[color:var(--border-subtle)] pt-sp-6">
        <h3
          className="m-0 text-danger-text font-semibold"
          style={{ fontSize: "var(--text-body-lg)" }}
        >
          {t("settings.workspace.general.delete_title")}
        </h3>
        <p
          className="mt-sp-2 mb-sp-4 m-0 text-fg-muted"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("settings.workspace.general.delete_description")}
        </p>
        {!showDeleteConfirm ? (
          <button
            type="button"
            onClick={() => { setShowDeleteConfirm(true); }}
            className="rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-3 font-medium text-danger-text transition-colors hover:bg-[color:var(--danger-subtle)]"
            style={{ fontSize: "var(--text-body)" }}
          >
            {t("settings.workspace.general.delete_action")}
          </button>
        ) : (
          <div className="flex flex-col gap-sp-4 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] p-sp-5">
            <p
              className="m-0 text-fg-muted"
              style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
            >
              {t("settings.workspace.general.delete_confirm_body", {
                name: workspace.name,
              })}
            </p>
            <Input
              value={deleteConfirmName}
              onChange={(event) => { setDeleteConfirmName(event.target.value); }}
              placeholder={workspace.name}
              aria-label={t("settings.workspace.general.delete_confirm_input_label")}
            />
            <div className="flex flex-wrap gap-sp-3">
              <button
                type="button"
                disabled={deleteConfirmName !== workspace.name || busy}
                onClick={() => { void onDeleteWorkspace(); }}
                className="rounded-md bg-danger px-sp-5 py-sp-3 font-medium text-[color:var(--danger-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ fontSize: "var(--text-body)" }}
              >
                {t("settings.workspace.general.delete_confirm_action")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmName("");
                }}
                className="rounded-md border border-[color:var(--border)] bg-raised px-sp-5 py-sp-3 font-medium text-fg"
                style={{ fontSize: "var(--text-body)" }}
              >
                {t("settings.account.cancel_action")}
              </button>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
