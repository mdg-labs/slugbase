import { SettingSwitch, SettingsSection } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useUpdatePreferences } from "./use-update-preferences.ts";

/**
 * The Sign-in alerts card of `/settings/account/security` (doc 03 section 11.2): whether the account is emailed when a
 * password sign-in comes from a device it has not signed in from (doc 02 section 12). `enabled` is what `GET /me` says;
 * a change shows at once and is taken back, with the reason beside the switch, when the server refuses it.
 */
export function SignInAlertsCard({ enabled }: { enabled: boolean }): ReactElement {
  const { t } = useTranslation();
  const update = useUpdatePreferences();

  return (
    <SettingsSection description={t("settings.security.alerts.description")} title={t("settings.security.alerts.title")}>
      <SettingSwitch
        checked={enabled}
        description={t("settings.security.alerts.switch.description")}
        error={update.isError ? t("settings.security.alerts.error.saveFailed") : undefined}
        label={t("settings.security.alerts.switch.label")}
        name="signinAlerts"
        onCheckedChange={(signinAlerts) => {
          update.mutate({ signinAlerts });
        }}
      />
    </SettingsSection>
  );
}
