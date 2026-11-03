import { Button } from "@slugbase/ui";
import { Banner, SelectField, feedbackToast } from "@slugbase/ui/patterns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AccountPreferences } from "../account/account-preferences.tsx";
import { ME_QUERY_KEY, meQuery, type Me } from "../account/me.ts";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { isExportOnlyRefusal } from "../api/client.ts";
import { useSignOut } from "../auth/sign-out.ts";
import { useConfig } from "../config/config-context.tsx";
import { useFormat } from "../i18n/use-format.ts";
import { useSwitchFailureMessage, useWorkspaceSwitch } from "./workspaces.ts";

/** The one page an export-only account has (doc 03 section 11.5): the page that exports. */
export const EXPORT_ONLY_PATH = "/settings/account/data";

/**
 * Makes the app read the account again when a request was refused with `403 account_export_only`: an instance admin may have left the
 * account to export only while the page was open, and the app then shows the export-only layout instead of pages that ask for what the
 * server refuses. A read or a write that fails any other way is left to its page.
 */
export function useRefreshOnExportOnly(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = (error: unknown): void => {
      if (isExportOnlyRefusal(error)) {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    };
    const stopQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        refresh(event.action.error);
      }
    });
    const stopMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        refresh(event.action.error);
      }
    });
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [queryClient]);
}

/**
 * The persistent banner for an account in the export-only access mode (doc 03 persistent banners, doc 02 section 2.11): it says when
 * the access ends and links to the page that exports. Nothing else of the app is open to the account, so the link is the one way on.
 */
export function ExportOnlyBanner(): ReactElement | null {
  const { t } = useTranslation();
  const account = useCachedAccount();
  const format = useFormat();
  if (account?.accessMode !== "exportOnly" || account.exportOnlyUntil === null) {
    return null;
  }
  const date = format.date(new Date(account.exportOnlyUntil), { dateStyle: "long", timeStyle: "short" });
  return (
    <Banner
      action={
        <Button render={<Link to={EXPORT_ONLY_PATH} />} size="sm" variant="outline">
          {t("shell.exportOnly.action")}
        </Button>
      }
      description={t("shell.exportOnly.description", { date })}
      title={t("shell.exportOnly.title")}
      variant="warning"
    />
  );
}

/** The workspace the exports are made from, chosen among the account's own; it appears when there are several. */
function ExportWorkspaceChoice({ me }: { me: Me | undefined }): ReactElement | null {
  const { t } = useTranslation();
  const { pending, switchTo } = useWorkspaceSwitch();
  const failureMessage = useSwitchFailureMessage();
  if (me === undefined || me.memberships.length < 2) {
    return null;
  }
  return (
    <SelectField
      description={t("shell.exportOnly.workspace.description")}
      disabled={pending}
      label={t("shell.exportOnly.workspace.label")}
      onValueChange={(workspaceId) => {
        void switchTo(workspaceId).then((outcome) => {
          if (outcome.status === "failed" && outcome.failure !== undefined) {
            feedbackToast.error(t("workspaces.switch.failed.title"), failureMessage(outcome.failure));
          }
        });
      }}
      options={me.memberships.map(({ workspaceId, name }) => ({ value: workspaceId, label: name }))}
      value={me.activeWorkspaceId ?? ""}
    />
  );
}

/**
 * The layout an export-only account gets in place of the app shell (doc 03 section 11.5, doc 02 section 2.11): the banner, the choice of
 * the workspace to export from, the export page and sign-out, and none of the navigation, search, creation or settings the server refuses.
 * Every page but the export page is replaced by it, so no request the server refuses is made.
 */
export function ExportOnlyLayout(): ReactElement {
  const { t } = useTranslation();
  const { product } = useConfig();
  const router = useRouter();
  const signOut = useSignOut();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The account is read again whenever the window regains focus, so a period an instance admin ended meanwhile gives the app back without a reload.
  const me = useQuery({ ...meQuery(router.options.context.api), staleTime: 0, refetchOnWindowFocus: "always" });
  useRefreshOnExportOnly();
  useEffect(() => {
    if (pathname !== EXPORT_ONLY_PATH) {
      void router.navigate({ to: EXPORT_ONLY_PATH, replace: true });
    }
  }, [pathname, router]);

  return (
    <AccountPreferences>
      <div className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
        <header className="flex items-center justify-between gap-4">
          <span className="font-semibold text-lg">{product.name}</span>
          <Button onClick={signOut} variant="outline">
            {t("shell.signOut")}
          </Button>
        </header>
        <ExportOnlyBanner />
        <ExportWorkspaceChoice me={me.data} />
        <main className="min-w-0 flex-1" id="main-content">
          {pathname === EXPORT_ONLY_PATH ? <Outlet /> : null}
        </main>
      </div>
    </AccountPreferences>
  );
}
