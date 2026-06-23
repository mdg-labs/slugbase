import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useAppToast } from "../../../../components/feedback/AppToastProvider.js";

import { deleteWorkspace, updateAiSettings, updateWorkspaceName } from "../workspace-api.js";
import {
  canManageWorkspaceSettings,
  listVisibleWorkspaceSections,
} from "../workspace-entitlements.js";
import type {
  AiSettingsData,
  WorkspaceSectionId,
  WorkspaceSettingsData,
} from "../workspace.types.js";
import { AiSection, defaultAi } from "./AiSection.js";
import { AdminRoleGate } from "./AdminRoleGate.js";
import { GeneralSection } from "./GeneralSection.js";
import { SettingsPageShell } from "../../../../components/settings/SettingsPageShell.js";

export interface WorkspaceSettingsPageProps {
  initialData: WorkspaceSettingsData;
}

export function WorkspaceSettingsPage({ initialData }: WorkspaceSettingsPageProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState(initialData.workspace);
  const [ai, setAi] = useState<AiSettingsData | null>(initialData.ai);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { showToast } = useAppToast();

  const visibleSections = useMemo(() => listVisibleWorkspaceSections(), []);

  const sectionParam = searchParams.get("section");
  const section: WorkspaceSectionId =
    sectionParam && visibleSections.includes(sectionParam as WorkspaceSectionId)
      ? (sectionParam as WorkspaceSectionId)
      : visibleSections[0] ?? "general";

  const showError = (message: string) => {
    setErrorMessage(message);
  };

  if (!canManageWorkspaceSettings(initialData.currentUserRole)) {
    return (
      <SettingsPageShell testId="workspace-settings-page">
        <header className="mb-sp-7">
          <h1
            className="m-0 text-fg font-semibold"
            style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
          >
            {t("settings.workspace.page_title")}
          </h1>
        </header>
        <AdminRoleGate t={t} />
      </SettingsPageShell>
    );
  }

  const renderSection = () => {
    if (section === "general") {
      return (
        <GeneralSection
          workspace={workspace}
          t={t}
          onSaveName={async (name) => {
            try {
              const updated = await updateWorkspaceName(name);
              setWorkspace(updated);
              showToast("settings.workspace.general.toast_saved");
            } catch (err) {
              showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
            }
          }}
          onDeleteWorkspace={async () => {
            try {
              await deleteWorkspace();
              showToast("settings.workspace.general.toast_deleted");
            } catch (err) {
              showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
            }
          }}
        />
      );
    }

    return (
      <AiSection
        initial={ai ?? defaultAi}
        interfaceConfig={initialData.interfaceConfig}
        t={t}
        onSave={async (payload) => {
          try {
            const updated = await updateAiSettings(payload);
            setAi(updated);
            showToast("settings.workspace.ai.toast_saved");
          } catch (err) {
            showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
          }
        }}
      />
    );
  };

  return (
    <SettingsPageShell testId="workspace-settings-page">
      {errorMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3 text-danger-text"
          role="alert"
          style={{ fontSize: "var(--text-small)" }}
        >
          {errorMessage}
        </p>
      ) : null}

      {renderSection()}
    </SettingsPageShell>
  );
}
