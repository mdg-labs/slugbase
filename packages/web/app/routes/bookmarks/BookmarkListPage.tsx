import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";
import { Form, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { ScopeFilter } from "../../components/sharing/ScopeFilter.js";
import { ScopeIcon } from "../../components/sharing/ScopeIcon.js";
import { ShareControls } from "../../components/sharing/ShareControls.js";
import { SharingLabel } from "../../components/sharing/SharingLabel.js";
import type { SharingScope } from "../../components/sharing/sharing.types.js";
import { resolveResourceSharingScope } from "../../components/sharing/sharing.utils.js";
import { useWorkspaceEntitlements } from "../../components/sharing/use-workspace-entitlements.js";
import {
  buildBookmarkListSearch,
  type BookmarkListData,
} from "./bookmarks-loader.js";

export function BookmarkListPage() {
  const { t } = useTranslate();
  const data = useLoaderData<BookmarkListData>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentUserId, canShare } = useWorkspaceEntitlements();

  const updateScope = (scope: SharingScope) => {
    const next = new URLSearchParams(searchParams);
    if (scope === "all") {
      next.delete("scope");
    } else {
      next.set("scope", scope);
    }
    next.delete("page");
    void navigate(`/bookmarks?${next.toString()}`);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8">
      <header className="flex flex-wrap items-end justify-between gap-sp-4">
        <div>
          <h1
            className="font-semibold text-fg"
            style={{ fontSize: "var(--text-h1)", lineHeight: "var(--lh-h1)" }}
          >
            {t("bookmarks.list.title")}
          </h1>
          <p className="mt-sp-2 text-fg-muted" style={{ fontSize: "var(--text-body)" }}>
            {t("bookmarks.list.subtitle", { count: data.total })}
          </p>
        </div>
      </header>

      <div
        className="flex flex-wrap items-center gap-sp-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-5 py-sp-4"
        data-testid="bookmark-list-toolbar"
      >
        <Form method="get" className="flex min-w-[14rem] flex-1 items-center gap-sp-3">
          <input type="hidden" name="scope" value={data.scope === "all" ? "" : data.scope} />
          <input
            name="q"
            defaultValue={data.q}
            placeholder={t("bookmarks.list.search_placeholder")}
            className="min-w-0 flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-4 py-sp-3 text-fg"
            data-testid="bookmark-list-search"
          />
          <Button type="submit" variant="secondary">
            {t("bookmarks.list.search_action")}
          </Button>
        </Form>

        {canShare ? (
          <ScopeFilter value={data.scope} onChange={updateScope} />
        ) : null}
      </div>

      {data.items.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-[color:var(--border)] px-sp-8 py-sp-10 text-center"
          data-testid="bookmark-list-empty"
        >
          <p className="font-medium text-fg">{t("bookmarks.list.empty_title")}</p>
          <p className="mt-sp-2 text-fg-muted">{t("bookmarks.list.empty_body")}</p>
        </div>
      ) : (
        <ul className="grid gap-sp-4" data-testid="bookmark-list">
          {data.items.map((bookmark) => {
            const itemScope = resolveResourceSharingScope(
              bookmark.userId,
              currentUserId,
              bookmark.shareGrantCount,
            );
            return (
              <li
                key={bookmark.id}
                className="flex flex-wrap items-center gap-sp-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-5 py-sp-4"
                data-testid={`bookmark-list-item-${bookmark.id}`}
                data-scope={itemScope}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-sp-3">
                    <p className="truncate font-medium text-fg">{bookmark.title}</p>
                    <ScopeIcon scope={itemScope} />
                    <SharingLabel
                      scope={itemScope}
                      shareGrantCount={bookmark.shareGrantCount}
                    />
                  </div>
                  <p className="truncate text-small text-fg-muted">{bookmark.url}</p>
                  {bookmark.slug ? (
                    <p
                      className="mt-sp-1 font-mono text-small text-fg-subtle"
                      data-testid={`bookmark-slug-${bookmark.id}`}
                    >
                      /go/{bookmark.slug}
                    </p>
                  ) : null}
                </div>
                <ShareControls
                  resourceKind="bookmark"
                  resourceId={bookmark.id}
                  resourceTitle={bookmark.title}
                  ownerUserId={bookmark.userId}
                  compact
                  onUpdated={() => {
                    void navigate(`/bookmarks${buildBookmarkListSearch({
                      scope: data.scope,
                      q: data.q || undefined,
                      page: data.page,
                      pageSize: data.pageSize,
                      sort: data.sort,
                    })}`);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
