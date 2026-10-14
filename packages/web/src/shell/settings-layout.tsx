import { SettingsNav, type SettingsNavGroup } from "@slugbase/ui/patterns";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Slot } from "../extensions/index.ts";

const PROFILE_PATH = "/settings/account";

/**
 * The layout of the settings pages (doc 03 section 11): the settings navigation beside the page, a
 * Select of the same pages on a narrow screen. Each page adds its own entry as it arrives.
 */
export function SettingsLayout(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const groups: readonly SettingsNavGroup[] = [
    {
      id: "account",
      label: t("settings.nav.account"),
      items: [{ id: "profile", label: t("settings.nav.profile"), link: <Link to={PROFILE_PATH} />, current: pathname === PROFILE_PATH }],
    },
  ];
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:flex-row md:items-start md:p-6">
      <SettingsNav
        className="md:w-56 md:shrink-0"
        footer={<Slot name="settings.workspace.nav" />}
        groups={groups}
        label={t("settings.navigation")}
        onNavigate={(id) => {
          if (id === "profile") {
            void router.navigate({ to: PROFILE_PATH });
          }
        }}
      />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
