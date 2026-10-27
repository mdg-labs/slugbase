import { Button } from "@slugbase/ui";
import { Banner, Loading } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useRouter } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AccountPreferences } from "../account/account-preferences.tsx";
import { meQuery } from "../account/me.ts";
import { isValidSlug } from "../bookmarks/bookmarks.ts";
import { NotFoundPage } from "../shell/error-pages.tsx";
import { CandidatesView } from "./candidates-view.tsx";
import { ForwardView } from "./forward-view.tsx";
import { resolveQuery } from "./go.ts";
import { SlugNotFoundView } from "./slug-not-found-view.tsx";

function Frame({ children }: { children: ReactNode }): ReactElement {
  return (
    <AccountPreferences>
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center p-4 sm:p-6">{children}</main>
    </AccountPreferences>
  );
}

function LoadFailure({ onRetry }: { onRetry: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <Banner
      action={
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("go.retry")}
        </Button>
      }
      description={t("go.loadFailed.description")}
      title={t("go.loadFailed.title")}
      variant="error"
    />
  );
}

/**
 * `/go/$slug` (doc 03 section 10, doc 02 sections 6.2 to 6.4): what the server leaves to the app when it cannot forward a slug itself. The
 * page has no sidebar, only the member's theme. It asks `POST /go/resolve` for the slug in the active workspace and shows the answer:
 * a bookmark to go to, several to choose from, or none. A slug outside the grammar and anything after the slug, a query string here
 * or a path, is not a different address and shows the page that does not exist (doc 02 section 6.2 step 5).
 */
export function GoPage({ slug: asked, beyondSlug }: { readonly slug: string; readonly beyondSlug: boolean }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const slug = asked.trim().toLowerCase();
  const exists = !beyondSlug && searchStr === "" && isValidSlug(slug);
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const workspaceId = me.data?.activeWorkspaceId ?? undefined;
  const resolve = useQuery({ ...resolveQuery(api, slug), enabled: exists && workspaceId !== undefined });

  let body: ReactElement;
  if (!exists) {
    body = <NotFoundPage />;
  } else if (me.isError) {
    body = (
      <LoadFailure
        onRetry={() => {
          void me.refetch();
        }}
      />
    );
  } else if (me.data?.activeWorkspaceId === null) {
    return <Navigate replace to="/no-workspace" />;
  } else if (resolve.isError) {
    body = (
      <LoadFailure
        onRetry={() => {
          void resolve.refetch();
        }}
      />
    );
  } else if (me.data === undefined || resolve.data === undefined || resolve.isFetching) {
    body = <Loading className="p-0" label={t("shell.loading")} />;
  } else {
    const answer = resolve.data;
    const refresh = (): void => {
      void resolve.refetch();
    };
    if (answer.result === "none") {
      const workspaceName = me.data.memberships.find((membership) => membership.workspaceId === workspaceId)?.name;
      body = <SlugNotFoundView onRefresh={refresh} otherWorkspaces={answer.otherWorkspaces} slug={slug} workspaceName={workspaceName} />;
    } else if (answer.result === "multiple") {
      body = <CandidatesView candidates={answer.candidates} key={resolve.dataUpdatedAt} onRefresh={refresh} slug={slug} />;
    } else {
      body = <ForwardView bookmark={answer.bookmark} key={resolve.dataUpdatedAt} onRetry={refresh} slug={slug} />;
    }
  }
  return <Frame>{body}</Frame>;
}
