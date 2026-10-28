import { Button } from "@slugbase/ui";
import { AccentChoice, Banner, Loading, SegmentedChoice, SettingSwitch, SettingsSection } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../config/config-context.tsx";
import { meQuery, type Account, type PreferenceChanges } from "./me.ts";
import { useCachedAccount } from "./use-cached-account.ts";
import { useUpdatePreferences } from "./use-update-preferences.ts";

type PreferenceName = keyof PreferenceChanges;

const THEMES = ["system", "dark", "light"] as const;
const VIEWS = ["grid", "table"] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function PreferencesForm({ account }: { account: Account }): ReactElement {
  const { t } = useTranslation();
  const { features } = useConfig();
  const update = useUpdatePreferences();

  // The field a refused or failed save names, until the next change is made.
  const failed: ReadonlySet<string> = update.isError ? new Set(Object.keys(update.variables)) : new Set();
  const saveFailed = t("settings.preferences.error.saveFailed");
  const errorOf = (name: PreferenceName): string | undefined => (failed.has(name) ? saveFailed : undefined);
  const themeError = errorOf("theme");
  const accentError = errorOf("accent");
  const viewError = errorOf("defaultView");
  const shortcutsError = errorOf("singleKeyShortcuts");
  const aiError = errorOf("aiOptOut");
  const checklistError = errorOf("onboarding");

  const themeOptions = [
    { value: "system", label: t("settings.preferences.theme.option.system") },
    { value: "dark", label: t("settings.preferences.theme.option.dark") },
    { value: "light", label: t("settings.preferences.theme.option.light") },
  ];
  const viewOptions = [
    { value: "grid", label: t("settings.preferences.view.option.grid") },
    { value: "table", label: t("settings.preferences.view.option.table") },
  ];
  const accentNames = {
    periwinkle: t("settings.preferences.accent.option.periwinkle"),
    violet: t("settings.preferences.accent.option.violet"),
    rose: t("settings.preferences.accent.option.rose"),
    amber: t("settings.preferences.accent.option.amber"),
    green: t("settings.preferences.accent.option.green"),
    teal: t("settings.preferences.accent.option.teal"),
  };

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
        {update.isPending ? t("settings.preferences.status.saving") : update.isSuccess ? t("settings.preferences.status.saved") : null}
      </p>
      <SettingsSection description={t("settings.preferences.appearance.description")} title={t("settings.preferences.appearance.title")}>
        <div className="flex flex-col gap-5">
          <SegmentedChoice
            description={t("settings.preferences.theme.description")}
            error={themeError}
            label={t("settings.preferences.theme.label")}
            name="theme"
            onValueChange={(next) => {
              const theme = oneOf(next, THEMES);
              if (theme !== undefined && theme !== account.theme) {
                update.mutate({ theme });
              }
            }}
            options={themeOptions}
            value={account.theme}
          />
          <AccentChoice
            description={t("settings.preferences.accent.description")}
            error={accentError}
            label={t("settings.preferences.accent.label")}
            name="accent"
            names={accentNames}
            onValueChange={(accent) => {
              if (accent !== (account.accent ?? "periwinkle")) {
                update.mutate({ accent });
              }
            }}
            value={account.accent ?? "periwinkle"}
          />
          <SegmentedChoice
            description={t("settings.preferences.view.description")}
            error={viewError}
            label={t("settings.preferences.view.label")}
            name="defaultView"
            onValueChange={(next) => {
              const defaultView = oneOf(next, VIEWS);
              if (defaultView !== undefined && defaultView !== account.defaultView) {
                update.mutate({ defaultView });
              }
            }}
            options={viewOptions}
            value={account.defaultView}
          />
        </div>
      </SettingsSection>
      <SettingsSection description={t("settings.preferences.shortcuts.description")} title={t("settings.preferences.shortcuts.title")}>
        <SettingSwitch
          checked={account.singleKeyShortcuts}
          description={t("settings.preferences.shortcuts.single.description")}
          error={shortcutsError}
          label={t("settings.preferences.shortcuts.single.label")}
          name="singleKeyShortcuts"
          onCheckedChange={(singleKeyShortcuts) => {
            update.mutate({ singleKeyShortcuts });
          }}
        />
      </SettingsSection>
      <SettingsSection description={t("settings.preferences.checklist.description")} title={t("settings.preferences.checklist.title")}>
        <SettingSwitch
          checked={!account.onboarding.checklistDismissed}
          description={t("settings.preferences.checklist.show.description")}
          error={checklistError}
          label={t("settings.preferences.checklist.show.label")}
          name="checklistDismissed"
          onCheckedChange={(show) => {
            update.mutate({ onboarding: { checklistDismissed: !show } });
          }}
        />
      </SettingsSection>
      {features.ai ? (
        <SettingsSection description={t("settings.preferences.ai.description")} title={t("settings.preferences.ai.title")}>
          <SettingSwitch
            checked={account.aiOptOut}
            description={t("settings.preferences.ai.optOut.description")}
            error={aiError}
            label={t("settings.preferences.ai.optOut.label")}
            name="aiOptOut"
            onCheckedChange={(aiOptOut) => {
              update.mutate({ aiOptOut });
            }}
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}

/** `/settings/account/preferences` (doc 03 section 11.4): theme, accent, default view, shortcuts, the Getting started checklist and the AI opt-out, each saved as it is changed. */
export function AccountPreferencesPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));
  // Read from the cache the way the theme and the accent are, so a choice shows in the same render that applies it.
  const account = useCachedAccount();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-semibold text-xl">{t("settings.preferences.title")}</h1>
      {account === undefined ? null : <PreferencesForm account={account} key={account.id} />}
      {me.isPending ? <Loading label={t("shell.loading")} /> : null}
      {me.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void me.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.preferences.loadFailed.title")}
          variant="error"
        />
      ) : null}
    </div>
  );
}
