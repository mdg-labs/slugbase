import { Button } from "@slugbase/ui";
import { Banner, DataTable, EmptyState, Loading, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FolderGlyph } from "../folders/folder-glyph.tsx";
import { useFormat } from "../i18n/use-format.ts";
import { formerBookmarksQuery, formerFoldersQuery, type FormerBookmark, type FormerFolder } from "./former-content.ts";
import { useActiveWorkspaceId } from "./workspace-members.ts";

/** What a list below reads of its query: how it stands, and how to load more of it or to ask for it again. */
interface PagedList {
  readonly isError: boolean;
  readonly isFetchNextPageError: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
  readonly refetch: () => Promise<unknown>;
}

interface ListBlockProps<Row extends object> {
  readonly title: string;
  readonly failedTitle: string;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly list: PagedList;
}

/**
 * One list of the section: its table with Show more, and an error with a retry when a request of it failed. A failed
 * request is never drawn as an empty list: the rows the earlier pages gave stay, and the error stands above them. A list
 * with no rows draws nothing of its own, the section says so when both are empty.
 */
function ListBlock<Row extends object>({ title, failedTitle, columns, rows, rowKey, list }: ListBlockProps<Row>): ReactElement | null {
  const { t } = useTranslation();
  return (
    <>
      {list.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch());
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={failedTitle}
          variant="error"
        />
      ) : null}
      {rows.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <h3 className="font-medium text-base">{title}</h3>
          <DataTable columns={columns} label={title} rowKey={rowKey} rows={rows} />
          {list.hasNextPage && !list.isError ? (
            <div className="flex justify-center">
              <Button
                loading={list.isFetchingNextPage}
                onClick={() => {
                  void list.fetchNextPage();
                }}
                variant="outline"
              >
                {t("settings.members.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * The content of former members of the workspace (doc 03 section 11.7, doc 02 section 2.10): the bookmarks and folders that have no owner because their
 * owner left the workspace or deleted their account, which only an owner or admin sees. Two tables, each paged by the server's cursor; the section says so
 * when both are empty and carries no action on a row.
 */
function FormerContentLists({ workspaceId }: { workspaceId: string }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const api = useRouter().options.context.api;
  const bookmarks = useInfiniteQuery(formerBookmarksQuery(api, workspaceId));
  const folders = useInfiniteQuery(formerFoldersQuery(api, workspaceId));
  const bookmarkRows = bookmarks.data?.pages.flatMap((page) => page.items) ?? [];
  const folderRows = folders.data?.pages.flatMap((page) => page.items) ?? [];
  const date = (value: string): string => format.date(new Date(value), { dateStyle: "medium" });

  const bookmarkColumns: readonly DataTableColumn<FormerBookmark>[] = [
    { id: "title", header: t("settings.members.former.bookmarks.column.title"), cell: (bookmark) => <span className="font-medium">{bookmark.title}</span> },
    { id: "host", header: t("settings.members.former.bookmarks.column.host"), cell: (bookmark) => bookmark.host },
    {
      id: "slug",
      header: t("settings.members.former.bookmarks.column.slug"),
      cell: (bookmark) => (bookmark.slug === null ? <span className="text-muted-foreground">{t("settings.members.former.bookmarks.noSlug")}</span> : bookmark.slug),
    },
    { id: "created", header: t("settings.members.former.column.created"), cell: (bookmark) => date(bookmark.createdAt) },
  ];

  const folderColumns: readonly DataTableColumn<FormerFolder>[] = [
    {
      id: "name",
      header: t("settings.members.former.folders.column.name"),
      cell: (folder) => (
        <span className="flex items-center gap-2">
          <FolderGlyph color={folder.color} icon={folder.icon} />
          <span className="font-medium">{folder.name}</span>
        </span>
      ),
    },
    { id: "bookmarks", header: t("settings.members.former.folders.column.bookmarks"), cell: (folder) => format.number(folder.bookmarkCount) },
    { id: "created", header: t("settings.members.former.column.created"), cell: (folder) => date(folder.createdAt) },
  ];

  const loading = bookmarks.isPending || folders.isPending;
  const empty = bookmarks.isSuccess && folders.isSuccess && bookmarkRows.length === 0 && folderRows.length === 0;

  return (
    <section aria-labelledby="former-content-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-lg" id="former-content-heading">
          {t("settings.members.former.title")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("settings.members.former.description")}</p>
      </div>
      {loading ? <Loading label={t("settings.members.former.loading")} /> : null}
      {empty ? (
        <EmptyState description={t("settings.members.former.empty.description")} headingLevel={3} title={t("settings.members.former.empty.title")} />
      ) : null}
      <ListBlock
        columns={bookmarkColumns}
        failedTitle={t("settings.members.former.bookmarks.loadFailed")}
        list={bookmarks}
        rowKey={(bookmark) => bookmark.id}
        rows={bookmarkRows}
        title={t("settings.members.former.bookmarks.title")}
      />
      <ListBlock
        columns={folderColumns}
        failedTitle={t("settings.members.former.folders.loadFailed")}
        list={folders}
        rowKey={(folder) => folder.id}
        rows={folderRows}
        title={t("settings.members.former.folders.title")}
      />
    </section>
  );
}

/**
 * The former members' content of the workspace the session acts in. It is rendered for owners and admins only, so a member never sends its
 * requests; the lists and their state start afresh when the workspace changes.
 */
export function FormerContentSection(): ReactElement | null {
  const workspaceId = useActiveWorkspaceId();
  return workspaceId === undefined ? null : <FormerContentLists key={workspaceId} workspaceId={workspaceId} />;
}
