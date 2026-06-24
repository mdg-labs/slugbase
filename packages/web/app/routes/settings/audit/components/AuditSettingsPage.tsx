import { useTranslation } from "react-i18next";

import { SettingsPageShell } from "../../../../components/settings/SettingsPageShell.js";
import { isPlanGatingEnabled } from "../../../../lib/billing-config.js";
import { AdminRoleGate } from "../../workspace/components/AdminRoleGate.js";
import type { AuditLoaderData } from "../audit.types.js";
import { AuditLogPage } from "./AuditLogPage.js";
import { AuditPlanGate } from "./AuditPlanGate.js";

interface AuditSettingsPageProps {
  data: AuditLoaderData;
}

export function AuditSettingsPage({ data }: AuditSettingsPageProps) {
  const { t } = useTranslation();

  if (data.roleDenied) {
    return (
      <SettingsPageShell testId="audit-settings-page">
        <header className="mb-sp-8">
          <h1 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
            {t("settings.audit.page_title")}
          </h1>
        </header>
        <AdminRoleGate t={t} />
      </SettingsPageShell>
    );
  }

  if (data.planDenied && isPlanGatingEnabled()) {
    return <AuditPlanGate />;
  }

  if (data.loadError || !data.events) {
    return (
      <SettingsPageShell testId="audit-settings-page">
        <header className="mb-sp-8">
          <h1 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
            {t("settings.audit.page_title")}
          </h1>
        </header>
        <p
          className="m-0 rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-small)] text-fg"
          data-testid="audit-load-error"
          role="alert"
        >
          {t("settings.audit.load_error")}
        </p>
      </SettingsPageShell>
    );
  }

  return <AuditLogPage events={data.events} />;
}
