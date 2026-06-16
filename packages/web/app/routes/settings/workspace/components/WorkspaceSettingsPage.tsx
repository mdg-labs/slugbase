import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useAppToast } from "../../../../components/feedback/AppToastProvider.js";

import {
  createOidcProvider,
  deleteOidcProvider,
  deleteWorkspace,
  sendMailTest,
  updateAiSettings,
  updateMailSettings,
  updateOidcProvider,
  updateWorkspaceName,
} from "../workspace-api.js";
import {
  canManageWorkspaceSettings,
  isWorkspaceSectionVisible,
  listVisibleWorkspaceSections,
} from "../workspace-entitlements.js";
import type {
  AiSettingsData,
  MailSettingsData,
  WorkspaceSectionId,
  WorkspaceSettingsData,
} from "../workspace.types.js";
import { AiSection, defaultAi } from "./AiSection.js";
import { AdminRoleGate } from "./AdminRoleGate.js";
import { GeneralSection } from "./GeneralSection.js";
import { OperatorManagedGate } from "./OperatorManagedGate.js";
import { SmtpSection, defaultMail } from "./SmtpSection.js";
import { OidcSection } from "./OidcSection.js";
import { SettingsPageShell } from "../../../../components/settings/SettingsPageShell.js";

export interface WorkspaceSettingsPageProps {
  initialData: WorkspaceSettingsData;
}

export function WorkspaceSettingsPage({ initialData }: WorkspaceSettingsPageProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState(initialData.workspace);
  const [mail, setMail] = useState<MailSettingsData | null>(initialData.mail);
  const [ai, setAi] = useState<AiSettingsData | null>(initialData.ai);
  const [providers, setProviders] = useState(initialData.oidcProviders);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { showToast } = useAppToast();

  const visibleSections = useMemo(
    () => listVisibleWorkspaceSections(initialData.interfaceConfig),
    [initialData.interfaceConfig],
  );

  const sectionParam = searchParams.get("section") as WorkspaceSectionId | null;
  const section =
    sectionParam && visibleSections.includes(sectionParam)
      ? sectionParam
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
    if (!isWorkspaceSectionVisible(section, initialData.interfaceConfig)) {
      if (section === "smtp") {
        return (
          <OperatorManagedGate
            titleKey="settings.workspace.smtp.operator_title"
            bodyKey="settings.workspace.smtp.operator_body"
            t={t}
          />
        );
      }
      if (section === "oidc") {
        return (
          <OperatorManagedGate
            titleKey="settings.workspace.oidc.operator_title"
            bodyKey="settings.workspace.oidc.operator_body"
            t={t}
          />
        );
      }
    }

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

    if (section === "smtp" && initialData.interfaceConfig.mailAdminUi) {
      return (
        <SmtpSection
          initial={mail ?? defaultMail}
          t={t}
          onSave={async (payload) => {
            try {
              const updated = await updateMailSettings(payload);
              setMail(updated);
              showToast("settings.workspace.smtp.toast_saved");
            } catch (err) {
              showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
            }
          }}
          onSendTest={async (email) => {
            await sendMailTest(email);
          }}
        />
      );
    }

    if (section === "ai") {
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
    }

    if (section === "oidc" && initialData.interfaceConfig.oidcAdminUi) {
      return (
        <OidcSection
          providers={providers}
          appBaseUrl={initialData.appBaseUrl}
          t={t}
          onCreate={async (payload) => {
            try {
              const created = await createOidcProvider(payload);
              setProviders((prev) => [...prev, created]);
              showToast("settings.workspace.oidc.toast_created", { name: created.name });
            } catch (err) {
              showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
            }
          }}
          onToggle={async (providerId, enabled) => {
            try {
              const updated = await updateOidcProvider(providerId, { enabled });
              setProviders((prev) =>
                prev.map((item) => (item.id === providerId ? updated : item)),
              );
              showToast("settings.workspace.oidc.toast_updated");
            } catch (err) {
              showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
            }
          }}
          onDelete={async (providerId) => {
            try {
              await deleteOidcProvider(providerId);
              setProviders((prev) => prev.filter((item) => item.id !== providerId));
              showToast("settings.workspace.oidc.toast_deleted");
            } catch (err) {
              showError(err instanceof Error ? err.message : t("settings.workspace.error_generic"));
            }
          }}
        />
      );
    }

    return null;
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
