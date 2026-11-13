import { Button } from "@slugbase/ui";
import { Banner, Confirm, DataTable, EmptyState, Loading, SelectCheckbox, feedbackToast, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FolderGlyph } from "../folders/folder-glyph.tsx";
import { FOLDERS_QUERY_KEY } from "../folders/folders.ts";
import { useFormat } from "../i18n/use-format.ts";
import { FormerContentReassignDialog } from "./former-content-reassign-dialog.tsx";
import { formerContentSummary } from "./former-content-summary.ts";
import {
  FORMER_CONTENT_QUERY_KEY,
  FORMER_CONTENT_REASSIGN_MAX,
  deleteFormerContent,
  formerBookmarksQuery,
  formerFoldersQuery,
  isReassignSelectionTooLarge,
  type FormerBookmark,
  type FormerContentDeleted,
  type FormerContentReassigned,
  type FormerFolder,
} from "./former-content.ts";
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
 * owner left the workspace or deleted their account, which only an owner or admin sees. Two tables, each paged by the server's cursor, each row selectable; the section says so
 * when both are empty. Delete acts on the selected rows after a confirmation that states the counts: the deletion is for good, with no trash and no undo. Reassign to... gives
 * the selected rows to a member picked in a dialog (FormerContentReassignDialog). The lists are read again after every deletion and every reassignment, whatever its outcome, and
 * a selection keeps only the rows the lists still hold, so a failed request leaves it and a row that left the lists leaves it.
 */
function FormerContentLists({ workspaceId }: { workspaceId: string }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const api = useRouter().options.context.api;
  const bookmarks = useInfiniteQuery(formerBookmarksQuery(api, workspaceId));
  const folders = useInfiniteQuery(formerFoldersQuery(api, workspaceId));
  const queryClient = useQueryClient();
  const bookmarkRows = bookmarks.data?.pages.flatMap((page) => page.items) ?? [];
  const folderRows = folders.data?.pages.flatMap((page) => page.items) ?? [];
  const [chosenBookmarks, setChosenBookmarks] = useState<ReadonlySet<string>>(new Set());
  const [chosenFolders, setChosenFolders] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const progress = useRef<FormerContentDeleted>({ bookmarksDeleted: 0, foldersDeleted: 0 });
  // The selection is what is chosen and still listed: a row the lists no longer hold (deleted, or gone for another reason) is not selected any more.
  const selectedBookmarks = bookmarkRows.filter((row) => chosenBookmarks.has(row.id)).map((row) => row.id);
  const selectedFolders = folderRows.filter((row) => chosenFolders.has(row.id)).map((row) => row.id);
  const selectedCount = selectedBookmarks.length + selectedFolders.length;
  // One reassignment is one request (it keeps the filings between the folders and the bookmarks selected together), so a selection past the server's limit is not offered.
  const reassignTooLarge = isReassignSelectionTooLarge(selectedBookmarks.length, selectedFolders.length);

  const summaryOf = (bookmarkCount: number, folderCount: number): string => formerContentSummary(t, bookmarkCount, folderCount);

  // `invalidateQueries` resolves when both lists have been read again, and never rejects: a list whose request fails shows its own error with a retry. The member's own
  // folders (the sidebar, mounted beside this page) are read again too, since a reassignment to oneself adds folders to them; that read is not waited for, so a sidebar
  // whose list fails and retries does not hold the confirmation open.
  const readAgain = (): Promise<void> => {
    void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
    return queryClient.invalidateQueries({ queryKey: [...FORMER_CONTENT_QUERY_KEY, workspaceId] });
  };

  // What a finished reassignment says: the counts the server gave, and the slugs, folder names and filings the move changed on the way.
  const reassigned = (result: FormerContentReassigned, recipientName: string): void => {
    setReassigning(false);
    setChosenBookmarks(new Set());
    setChosenFolders(new Set());
    if (result.bookmarksMoved + result.foldersMoved === 0) {
      feedbackToast.info(t("settings.members.former.reassign.nothing"));
      return;
    }
    const details = [
      result.slugsCleared > 0 ? t("settings.members.former.reassign.slugsCleared", { count: result.slugsCleared }) : undefined,
      result.foldersRenamed > 0 ? t("settings.members.former.reassign.foldersRenamed", { count: result.foldersRenamed }) : undefined,
      result.filingsRemoved > 0 ? t("settings.members.former.reassign.filingsRemoved", { count: result.filingsRemoved }) : undefined,
    ].filter((detail) => detail !== undefined);
    feedbackToast.success(
      t("settings.members.former.reassign.done", { summary: summaryOf(result.bookmarksMoved, result.foldersMoved), recipient: recipientName }),
      details.length === 0 ? undefined : details.join(" "),
    );
  };

  const remove = useMutation({
    mutationKey: ["workspace", "former-content", "delete"],
    mutationFn: (request: { readonly bookmarkIds: readonly string[]; readonly folderIds: readonly string[] }) => {
      progress.current = { bookmarksDeleted: 0, foldersDeleted: 0 };
      return deleteFormerContent(api, request, (deleted) => {
        progress.current = deleted;
      });
    },
    // Whatever the outcome, the lists are read again before anything else happens: TanStack Query waits for the promise an `onSuccess` or an `onError` returns before it
    // ends the mutation, so the dialog keeps showing its wait (`remove.isPending`) until the request and the reading of both lists are done, and only then closes.
    onSuccess: async (deleted) => {
      await readAgain();
      setConfirming(false);
      setChosenBookmarks(new Set());
      setChosenFolders(new Set());
      if (deleted.bookmarksDeleted + deleted.foldersDeleted === 0) {
        feedbackToast.info(t("settings.members.former.delete.nothing"));
        return;
      }
      feedbackToast.success(t("settings.members.former.delete.done", { summary: summaryOf(deleted.bookmarksDeleted, deleted.foldersDeleted) }));
    },
    onError: async () => {
      // The shared toast reports the failure; the selection stays. A selection that took several requests may have lost its first ones to the deletion: say so.
      await readAgain();
      setConfirming(false);
      const done = progress.current.bookmarksDeleted + progress.current.foldersDeleted;
      if (done > 0) {
        feedbackToast.error(t("settings.members.former.delete.partial", { done, total: selectedCount }));
      }
    },
  });

  function toggle(chosen: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
    const next = new Set(chosen);
    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }
    return next;
  }

  const date = (value: string): string => format.date(new Date(value), { dateStyle: "medium" });

  const bookmarkColumns: readonly DataTableColumn<FormerBookmark>[] = [
    {
      id: "select",
      header: (
        <SelectCheckbox
          checked={bookmarkRows.length > 0 && selectedBookmarks.length === bookmarkRows.length}
          label={t("settings.members.former.bookmarks.selectAll")}
          onCheckedChange={(on) => {
            setChosenBookmarks(on ? new Set(bookmarkRows.map((row) => row.id)) : new Set());
          }}
        />
      ),
      cell: (bookmark) => (
        <SelectCheckbox
          checked={chosenBookmarks.has(bookmark.id)}
          label={t("settings.members.former.bookmarks.select", { title: bookmark.title })}
          onCheckedChange={(on) => {
            setChosenBookmarks((chosen) => toggle(chosen, bookmark.id, on));
          }}
        />
      ),
    },
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
      id: "select",
      header: (
        <SelectCheckbox
          checked={folderRows.length > 0 && selectedFolders.length === folderRows.length}
          label={t("settings.members.former.folders.selectAll")}
          onCheckedChange={(on) => {
            setChosenFolders(on ? new Set(folderRows.map((row) => row.id)) : new Set());
          }}
        />
      ),
      cell: (folder) => (
        <SelectCheckbox
          checked={chosenFolders.has(folder.id)}
          label={t("settings.members.former.folders.select", { name: folder.name })}
          onCheckedChange={(on) => {
            setChosenFolders((chosen) => toggle(chosen, folder.id, on));
          }}
        />
      ),
    },
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
      {bookmarkRows.length + folderRows.length === 0 ? null : (
        <div aria-label={t("settings.members.former.selection.label")} className="flex flex-wrap items-center gap-3" role="group">
          <Button
            disabled={selectedCount === 0 || remove.isPending}
            onClick={() => {
              setConfirming(true);
            }}
            variant="destructive"
          >
            {t("settings.members.former.delete.action")}
          </Button>
          <Button
            disabled={selectedCount === 0 || remove.isPending || reassignTooLarge}
            onClick={() => {
              setReassigning(true);
            }}
            variant="outline"
          >
            {t("settings.members.former.reassign.action")}
          </Button>
          <span aria-live="polite" className="text-muted-foreground text-sm">
            {selectedCount === 0 ? null : t("settings.members.former.selection.count", { count: selectedCount })}
          </span>
          {reassignTooLarge ? (
            <span className="basis-full text-destructive-text text-sm" role="status">
              {t("settings.members.former.reassign.tooMany", { max: FORMER_CONTENT_REASSIGN_MAX })}
            </span>
          ) : null}
        </div>
      )}
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
      <Confirm
        cancelLabel={t("settings.members.former.delete.cancel")}
        confirmLabel={t("settings.members.former.delete.confirm")}
        description={
          <>
            {t("settings.members.former.delete.description", { summary: summaryOf(selectedBookmarks.length, selectedFolders.length) })}
            {selectedFolders.length > 0 ? ` ${t("settings.members.former.delete.foldersNote")}` : ""}
          </>
        }
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (!remove.isPending && selectedCount > 0) {
            remove.mutate({ bookmarkIds: selectedBookmarks, folderIds: selectedFolders });
          }
        }}
        onOpenChange={setConfirming}
        open={confirming}
        title={t("settings.members.former.delete.title")}
      />
      {reassigning ? (
        <FormerContentReassignDialog
          bookmarkIds={selectedBookmarks}
          folderIds={selectedFolders}
          onClose={() => {
            setReassigning(false);
          }}
          onReassigned={reassigned}
          readAgain={readAgain}
        />
      ) : null}
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
