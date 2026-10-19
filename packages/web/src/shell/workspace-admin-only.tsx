import { Button } from "@slugbase/ui";
import { Banner, Loading } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ForbiddenPage } from "./error-pages.tsx";
import { canAdminister, workspaceQuery } from "./workspace.ts";

/**
 * Guards a workspace settings page that only admins and owners may open (doc 03 section 11): a member sees the
 * in-app 403 page instead of the page. The role is the one the server reports for the workspace now, so a
 * change of role made elsewhere is honoured, and the page's own requests are not sent before the role is known.
 */
export function WorkspaceAdminOnly({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const workspace = useQuery(workspaceQuery(router.options.context.api));

  if (workspace.data === undefined) {
    return workspace.isError ? (
      <Banner
        action={
          <Button
            onClick={() => {
              void workspace.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("settings.account.loadFailed.retry")}
          </Button>
        }
        description={t("settings.account.loadFailed.description")}
        title={t("settings.workspace.loadFailed.title")}
        variant="error"
      />
    ) : (
      <Loading label={t("shell.loading")} />
    );
  }
  return canAdminister(workspace.data.role) ? <>{children}</> : <ForbiddenPage />;
}
