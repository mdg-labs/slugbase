import { Button } from "@slugbase/ui";
import { CompassIcon, CopyValue, EmptyState, HomeIcon, LockIcon, TriangleAlertIcon } from "@slugbase/ui/patterns";
import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";

function GoHome(): ReactElement {
  const { t } = useTranslation();
  return (
    <Button render={<Link to="/" />}>
      <HomeIcon aria-hidden="true" />
      {t("errorPage.goHome")}
    </Button>
  );
}

/** The catch-all route: a path that no page owns (doc 03 section 13). Rendered inside the shell. */
export function NotFoundPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <EmptyState
      actions={<GoHome />}
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
      actions={<GoHome />}
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
