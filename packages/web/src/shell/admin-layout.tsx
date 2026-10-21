import { Button } from "@slugbase/ui";
import { Banner, Loading, SettingsNav, type SettingsNavGroup } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { ForbiddenPage } from "./error-pages.tsx";

const OVERVIEW_PATH = "/admin";
const WORKSPACES_PATH = "/admin/workspaces";
const ACCOUNTS_PATH = "/admin/accounts";
const SETTINGS_PATH = "/admin/settings";

function MfaRequiredBanner(): ReactElement {
  const { t } = useTranslation();
  return (
    <Banner
      action={
        <Button render={<Link to="/settings/account/security" />} size="sm" variant="outline">
          {t("admin.mfaRequired.action")}
        </Button>
      }
      description={t("admin.mfaRequired.description")}
      title={t("admin.mfaRequired.title")}
      variant="warning"
    />
  );
}

/**
 * The layout of the instance admin pages (doc 03 section 12): their navigation beside the page. The pages are
 * only for an instance admin, so an account that is not one sees the 403 page, and an account that cannot be
 * loaded is not shown the area either. While the admin has no second factor every page carries the banner that
 * says so; the pages offer no action until then.
 */
export function AdminLayout(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const me = useQuery(meQuery(router.options.context.api));

  if (me.data === undefined) {
    return me.isError ? (
      <Banner
        action={
          <Button
            onClick={() => {
              void me.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("admin.loadFailed.retry")}
          </Button>
        }
        description={t("admin.loadFailed.description")}
        title={t("admin.loadFailed.title")}
        variant="error"
      />
    ) : (
      <Loading label={t("shell.loading")} />
    );
  }
  if (!me.data.account.isInstanceAdmin) {
    return <ForbiddenPage />;
  }

  const here = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const groups: SettingsNavGroup[] = [
    {
      id: "instance",
      label: t("admin.nav.instance"),
      items: [
        { id: "overview", label: t("admin.nav.overview"), link: <Link to={OVERVIEW_PATH} />, current: here === OVERVIEW_PATH },
        { id: "workspaces", label: t("admin.nav.workspaces"), link: <Link to={WORKSPACES_PATH} />, current: here === WORKSPACES_PATH },
        { id: "accounts", label: t("admin.nav.accounts"), link: <Link to={ACCOUNTS_PATH} />, current: here === ACCOUNTS_PATH },
        { id: "settings", label: t("admin.nav.settings"), link: <Link to={SETTINGS_PATH} />, current: here === SETTINGS_PATH },
      ],
    },
  ];
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:flex-row md:items-start md:p-6">
      <SettingsNav
        className="md:w-56 md:shrink-0"
        groups={groups}
        label={t("admin.navigation")}
        onNavigate={(id) => {
          if (id === "overview") {
            void router.navigate({ to: OVERVIEW_PATH });
          } else if (id === "workspaces") {
            void router.navigate({ to: WORKSPACES_PATH });
          } else if (id === "accounts") {
            void router.navigate({ to: ACCOUNTS_PATH });
          } else if (id === "settings") {
            void router.navigate({ to: SETTINGS_PATH });
          }
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {me.data.account.mfaEnabled ? null : <MfaRequiredBanner />}
        <Outlet />
      </div>
    </div>
  );
}
