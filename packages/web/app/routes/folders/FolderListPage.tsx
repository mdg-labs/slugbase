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
  buildFolderListSearch,
  type FolderListData,
} from "./folders-loader.js";

export function FolderListPage() {
  const { t } = useTranslate();
  const data = useLoaderData<FolderListData>();
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
    void navigate(`/folders?${next.toString()}`);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8">
      <header className="flex flex-wrap items-end justify-between gap-sp-4">
        <div>
          <h1
            className="font-semibold text-fg"
            style={{ fontSize: "var(--text-h1)", lineHeight: "var(--lh-h1)" }}
          >
            {t("folders.list.title")}
          </h1>
          <p className="mt-sp-2 text-fg-muted" style={{ fontSize: "var(--text-body)" }}>
            {t("folders.list.subtitle", { count: data.total })}
          </p>
        </div>
      </header>

      <div
        className="flex flex-wrap items-center gap-sp-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-5 py-sp-4"
        data-testid="folder-list-toolbar"
      >
        <Form method="get" className="flex min-w-[14rem] flex-1 items-center gap-sp-3">
          <input type="hidden" name="scope" value={data.scope === "all" ? "" : data.scope} />
          <input
            name="q"
            defaultValue={data.q}
            placeholder={t("folders.list.search_placeholder")}
            className="min-w-0 flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-4 py-sp-3 text-fg"
            data-testid="folder-list-search"
          />
          <Button type="submit" variant="secondary">
            {t("folders.list.search_action")}
          </Button>
        </Form>

        {canShare ? (
          <ScopeFilter
            value={data.scope}
            onChange={updateScope}
            resourceKind="folder"
          />
        ) : null}
      </div>

      {data.items.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-[color:var(--border)] px-sp-8 py-sp-10 text-center"
          data-testid="folder-list-empty"
        >
          <p className="font-medium text-fg">{t("folders.list.empty_title")}</p>
          <p className="mt-sp-2 text-fg-muted">{t("folders.list.empty_body")}</p>
        </div>
      ) : (
        <ul className="grid gap-sp-4" data-testid="folder-list">
          {data.items.map((folder) => {
            const itemScope = resolveResourceSharingScope(
              folder.userId,
              currentUserId,
              folder.shareGrantCount,
            );
            return (
              <li
                key={folder.id}
                className="flex flex-wrap items-center gap-sp-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-5 py-sp-4"
                data-testid={`folder-list-item-${folder.id}`}
                data-scope={itemScope}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-sp-3">
                    <p className="truncate font-medium text-fg">{folder.name}</p>
                    <ScopeIcon scope={itemScope} />
                    <SharingLabel
                      scope={itemScope}
                      shareGrantCount={folder.shareGrantCount}
                    />
                  </div>
                  <p className="text-small text-fg-muted">
                    {t("folders.list.bookmark_count", { count: folder.bookmarkCount })}
                  </p>
                </div>
                <ShareControls
                  resourceKind="folder"
                  resourceId={folder.id}
                  resourceTitle={folder.name}
                  ownerUserId={folder.userId}
                  compact
                  onUpdated={() => {
                    void navigate(`/folders${buildFolderListSearch({
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
