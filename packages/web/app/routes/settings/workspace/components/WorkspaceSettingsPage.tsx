import { useTranslate } from "@tolgee/react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

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

export interface WorkspaceSettingsPageProps {
  initialData: WorkspaceSettingsData;
}

export function WorkspaceSettingsPage({ initialData }: WorkspaceSettingsPageProps) {
  const { t } = useTranslate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState(initialData.workspace);
  const [mail, setMail] = useState<MailSettingsData | null>(initialData.mail);
  const [ai, setAi] = useState<AiSettingsData | null>(initialData.ai);
  const [providers, setProviders] = useState(initialData.oidcProviders);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const visibleSections = useMemo(
    () => listVisibleWorkspaceSections(initialData.interfaceConfig),
    [initialData.interfaceConfig],
  );

  const sectionParam = searchParams.get("section") as WorkspaceSectionId | null;
  const section =
    sectionParam && visibleSections.includes(sectionParam)
      ? sectionParam
      : visibleSections[0] ?? "general";

  const setSection = (next: WorkspaceSectionId) => {
    setSearchParams(next === "general" ? {} : { section: next });
  };

  const showToast = (messageKey: string, params?: Record<string, string>) => {
    setStatusMessage(t(messageKey, params));
    setErrorMessage(null);
  };

  const showError = (message: string) => {
    setErrorMessage(message);
    setStatusMessage(null);
  };

  if (!canManageWorkspaceSettings(initialData.currentUserRole)) {
    return (
      <div className="mx-auto max-w-[680px] px-sp-6 py-sp-8" data-testid="workspace-settings-page">
        <header className="mb-sp-7">
          <h1
            className="m-0 text-fg font-semibold"
            style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
          >
            {t("settings.workspace.page_title")}
          </h1>
        </header>
        <AdminRoleGate t={t} />
      </div>
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
    <div className="mx-auto max-w-[680px] px-sp-6 py-sp-8" data-testid="workspace-settings-page">
      <header className="mb-sp-7">
        <h1
          className="m-0 text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("settings.workspace.page_title")}
        </h1>
        <p
          className="mt-sp-2 m-0 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("settings.workspace.page_subtitle", { workspace: workspace.name })}
        </p>
      </header>

      {statusMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--success-subtle)] bg-[color:var(--success-subtle)] px-sp-4 py-sp-3 text-success-text"
          role="status"
          style={{ fontSize: "var(--text-small)" }}
        >
          {statusMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3 text-danger-text"
          role="alert"
          style={{ fontSize: "var(--text-small)" }}
        >
          {errorMessage}
        </p>
      ) : null}

      <nav
        className="mb-sp-7 flex flex-wrap gap-sp-2 border-b border-[color:var(--border-subtle)]"
        aria-label={t("settings.workspace.nav_label")}
      >
        {visibleSections.map((tabId) => (
          <button
            key={tabId}
            type="button"
            onClick={() => { setSection(tabId); }}
            className={`border-b-2 px-sp-4 py-sp-3 font-medium transition-colors ${
              section === tabId
                ? "border-[color:var(--accent)] text-fg"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
            style={{ fontSize: "var(--text-body)" }}
            aria-current={section === tabId ? "page" : undefined}
          >
            {t(`settings.workspace.tab_${tabId}`)}
          </button>
        ))}
      </nav>

      {renderSection()}
    </div>
  );
}
