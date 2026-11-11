import { Button } from "@slugbase/ui";
import { ArrowLeftRightIcon, CompassIcon, CopyValue, EmptyState, HomeIcon, LockIcon, SearchIcon, TriangleAlertIcon } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { useOpenPalette } from "../palette/palette-state.tsx";
import { useOpenWorkspaceSwitcher } from "./workspace-switcher.tsx";
import { workspacesQuery } from "./workspaces.ts";

function GoHome(): ReactElement {
  const { t } = useTranslation();
  return (
    <Button render={<Link to="/" />}>
      <HomeIcon aria-hidden="true" />
      {t("errorPage.goHome")}
    </Button>
  );
}

/** Opens the command palette, beside Go home. Offered only inside the shell: the 404 that a signed-out visitor sees has no palette. */
function SearchAction(): ReactElement | null {
  const { t } = useTranslation();
  const openPalette = useOpenPalette();
  if (openPalette === undefined) {
    return null;
  }
  return (
    <Button onClick={openPalette} variant="outline">
      <SearchIcon aria-hidden="true" />
      {t("errorPage.notFound.search")}
    </Button>
  );
}

/**
 * Opens the sidebar's workspace switcher, beside Go home. Offered inside the shell to a member of more than one workspace: the
 * count is the length of the account's workspace list (`GET /workspaces`), the list the switcher itself shows. With one
 * workspace, or while the list is not loaded, there is nothing to switch to and the action is left out.
 */
function SwitchWorkspaceAction(): ReactElement | null {
  const { t } = useTranslation();
  const openSwitcher = useOpenWorkspaceSwitcher();
  const { api } = useRouter().options.context;
  const list = useQuery({ ...workspacesQuery(api), enabled: openSwitcher !== undefined });
  if (openSwitcher === undefined || (list.data?.items.length ?? 0) < 2) {
    return null;
  }
  return (
    <Button onClick={openSwitcher} variant="outline">
      <ArrowLeftRightIcon aria-hidden="true" />
      {t("errorPage.forbidden.switchWorkspace")}
    </Button>
  );
}

/** The catch-all route: a path that no page owns (doc 03 section 13). Rendered inside the shell. */
export function NotFoundPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <EmptyState
      actions={
        <>
          <GoHome />
          <SearchAction />
        </>
      }
      description={t("errorPage.notFound.description")}
      headingLevel={1}
      icon={<CompassIcon aria-hidden="true" />}
      title={t("errorPage.notFound.title")}
    />
  );
}

/** What a page the member may not use shows (doc 03 section 13). Rendered inside the shell. */
export function ForbiddenPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <EmptyState
      actions={
        <>
          <GoHome />
          <SwitchWorkspaceAction />
        </>
      }
      description={t("errorPage.forbidden.description")}
      headingLevel={1}
      icon={<LockIcon aria-hidden="true" />}
      title={t("errorPage.forbidden.title")}
    />
  );
}

/**
 * The root error boundary (doc 03 section 13). It renders static copy and, when
 * the failure was an API problem, its request id; nothing else of the error
 * reaches the page (doc 04 section 3.1, T7).
 */
export function ServerErrorPage({ error }: ErrorComponentProps): ReactElement {
  const { t } = useTranslation();
  const requestId = error instanceof ApiProblemError ? error.requestId : undefined;
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center p-6">
      <EmptyState
        actions={
          <>
            {requestId === undefined ? null : (
              <CopyValue
                copiedLabel={t("errorPage.serverError.copied")}
                copyLabel={t("errorPage.serverError.copyRequestId")}
                label={t("errorPage.serverError.requestId")}
                value={requestId}
              />
            )}
            <Button
              onClick={() => {
                globalThis.location.reload();
              }}
            >
              {t("errorPage.serverError.reload")}
            </Button>
          </>
        }
        description={t("errorPage.serverError.description")}
        headingLevel={1}
        icon={<TriangleAlertIcon aria-hidden="true" />}
        title={t("errorPage.serverError.title")}
      />
    </main>
  );
}
