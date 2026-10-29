import { SettingsNav, type SettingsNavGroup } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { Slot } from "../extensions/index.ts";
import { activeRole, canAdminister } from "./workspace.ts";

const PROFILE_PATH = "/settings/account";
const PREFERENCES_PATH = "/settings/account/preferences";
const SECURITY_PATH = "/settings/account/security";
const TOKENS_PATH = "/settings/account/tokens";
const GENERAL_PATH = "/settings/workspace";
const MEMBERS_PATH = "/settings/workspace/members";
const TEAMS_PATH = "/settings/workspace/teams";

/**
 * The layout of the settings pages (doc 03 section 11): the settings navigation beside the page, a
 * Select of the same pages on a narrow screen. Each page adds its own entry as it arrives. The Workspace
 * group is for an account that acts in a workspace; it lists the pages of the workspace that the account's
 * role may open: General and Teams for everyone, Members for admins and owners.
 */
export function SettingsLayout(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const me = useQuery(meQuery(router.options.context.api));
  const inWorkspace = me.data !== undefined && me.data.activeWorkspaceId !== null;
  const groups: SettingsNavGroup[] = [
    {
      id: "account",
      label: t("settings.nav.account"),
      items: [
        { id: "profile", label: t("settings.nav.profile"), link: <Link to={PROFILE_PATH} />, current: pathname === PROFILE_PATH },
        {
          id: "preferences",
          label: t("settings.nav.preferences"),
          link: <Link to={PREFERENCES_PATH} />,
          current: pathname === PREFERENCES_PATH,
        },
        { id: "security", label: t("settings.nav.security"), link: <Link to={SECURITY_PATH} />, current: pathname === SECURITY_PATH },
        { id: "tokens", label: t("settings.nav.tokens"), link: <Link to={TOKENS_PATH} />, current: pathname === TOKENS_PATH },
      ],
    },
  ];
  if (inWorkspace) {
    const general = { id: "general", label: t("settings.nav.general"), link: <Link to={GENERAL_PATH} />, current: pathname === GENERAL_PATH };
    const members = { id: "members", label: t("settings.nav.members"), link: <Link to={MEMBERS_PATH} />, current: pathname === MEMBERS_PATH };
    const teams = { id: "teams", label: t("settings.nav.teams"), link: <Link to={TEAMS_PATH} />, current: pathname === TEAMS_PATH };
    groups.push({
      id: "workspace",
      label: t("settings.nav.workspace"),
      items: canAdminister(activeRole(me.data)) ? [general, members, teams] : [general, teams],
    });
  }
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
          } else if (id === "preferences") {
            void router.navigate({ to: PREFERENCES_PATH });
          } else if (id === "security") {
            void router.navigate({ to: SECURITY_PATH });
          } else if (id === "tokens") {
            void router.navigate({ to: TOKENS_PATH });
          } else if (id === "general") {
            void router.navigate({ to: GENERAL_PATH });
          } else if (id === "members") {
            void router.navigate({ to: MEMBERS_PATH });
          } else if (id === "teams") {
            void router.navigate({ to: TEAMS_PATH });
          }
        }}
      />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
