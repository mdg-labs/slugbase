import { DataTable, Favicon, PinIcon, RowActions, SelectCheckbox, type DataTableColumn, type DataTableSortDirection } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { useBookmarkActions, type BookmarkActionHandlers } from "./bookmark-card.tsx";
import { FolderDots, TagBadges } from "./bookmark-labels.tsx";
import { isHttpUrl, isSharedWithMe, recordOpen, type Bookmark } from "./bookmarks.ts";
import { SharedMarker } from "./shared-marker.tsx";
import { DEFAULT_SORT, type BookmarkSort } from "./list-search.ts";

export type BookmarksTableProps = Pick<BookmarkActionHandlers, "onEdit" | "onPin" | "onShare" | "onDelete"> & {
  readonly bookmarks: readonly Bookmark[];
  /** The bookmarks whose pin is being saved. */
  readonly pendingPins: ReadonlySet<string>;
  /** The identifiers of the selected bookmarks. */
  readonly selected: ReadonlySet<string>;
  /** Whether anything is selected, which makes the table a grid for assistive technology. */
  readonly selectionActive: boolean;
  /** The bookmark whose row is the table's one stop on the Tab key. */
  readonly tabStopId: string | undefined;
  readonly onSelectedChange: (bookmark: Bookmark, selected: boolean) => void;
  /** The order the rows are in now. */
  readonly sort: BookmarkSort | undefined;
  readonly onSort: (sort: BookmarkSort) => void;
};

function directionOf(sort: BookmarkSort, ascending: BookmarkSort | undefined, descending: BookmarkSort | undefined): DataTableSortDirection {
  if (sort === ascending) {
    return "ascending";
  }
  return sort === descending ? "descending" : "none";
}

function TitleCell({ bookmark }: { readonly bookmark: Bookmark }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const open = (): void => {
    recordOpen(router.options.context.api, bookmark.id);
  };
  return (
    <span className="flex items-center gap-3">
      <Favicon host={bookmark.host} />
      <span className="max-w-64 truncate font-medium text-sm lg:max-w-96">
        {isHttpUrl(bookmark.url) ? (
          <a
            className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            href={bookmark.url}
            onAuxClick={(event) => {
              if (event.button === 1) {
                open();
              }
            }}
            onClick={open}
            rel="noopener noreferrer"
          >
            {bookmark.title}
          </a>
        ) : (
          bookmark.title
        )}
      </span>
      {bookmark.pinned ? (
        <span className="text-muted-foreground" role="img" aria-label={t("bookmarks.list.pinned")}>
          <PinIcon aria-hidden="true" className="size-4" />
        </span>
      ) : null}
      {isSharedWithMe(bookmark) ? <SharedMarker bookmark={bookmark} /> : null}
    </span>
  );
}

function ActionsCell(props: BookmarkActionHandlers): ReactElement {
  const { t } = useTranslation();
  const actions = useBookmarkActions(props);
  return <RowActions actions={actions} label={t("bookmarks.list.actionsFor", { title: props.bookmark.title })} />;
}

/**
 * The bookmarks as a table (doc 03 section 3.3): the title, slug, host, usage and date columns, which order the list
 * from their headers, and the actions of the card. The address holds the order; below `md` each row is a card. The
 * folders column shows a dot for each folder and the tags column the first three tags.
 */
export function BookmarksTable({ bookmarks, pendingPins, sort: current, selected, selectionActive, tabStopId, onSelectedChange, onSort, onEdit, onPin, onShare, onDelete }: BookmarksTableProps): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const sort = current ?? DEFAULT_SORT;
  const columns: readonly DataTableColumn<Bookmark>[] = [
    {
      id: "select",
      header: t("bookmarks.list.table.select"),
      hideHeader: true,
      cardSlot: "leading",
      cell: (bookmark) => (
        <SelectCheckbox
          checked={selected.has(bookmark.id)}
          label={t("bookmarks.list.select", { title: bookmark.title })}
          onCheckedChange={(next) => {
            onSelectedChange(bookmark, next);
          }}
        />
      ),
    },
    {
      id: "title",
      header: t("bookmarks.list.table.title"),
      cardSlot: "title",
      cell: (bookmark) => <TitleCell bookmark={bookmark} />,
      sort: { direction: directionOf(sort, "title_asc", "title_desc"), onSort: () => { onSort(sort === "title_asc" ? "title_desc" : "title_asc"); } },
    },
    {
      id: "slug",
      header: t("bookmarks.list.table.slug"),
      cell: (bookmark) =>
        bookmark.slug === null ? null : (
          <span className="font-mono text-xs" translate="no">
            {`/go/${bookmark.slug}`}
          </span>
        ),
    },
    {
      id: "host",
      header: t("bookmarks.list.table.host"),
      cell: (bookmark) => (
        <span className="block max-w-48 truncate font-mono text-muted-foreground text-xs" translate="no">
          {bookmark.host}
        </span>
      ),
    },
    { id: "folders", header: t("bookmarks.list.table.folders"), cell: (bookmark) => <FolderDots folders={bookmark.folders} /> },
    { id: "tags", header: t("bookmarks.list.table.tags"), cell: (bookmark) => <TagBadges tags={bookmark.tags} /> },
    {
      id: "opens",
      header: t("bookmarks.list.table.opens"),
      cell: (bookmark) => format.number(bookmark.openCount),
      sort: { direction: directionOf(sort, undefined, "most_used"), onSort: () => { onSort("most_used"); } },
    },
    {
      id: "lastOpened",
      header: t("bookmarks.list.table.lastOpened"),
      cell: (bookmark) =>
        bookmark.lastOpenedAt === null ? <span className="text-muted-foreground">{t("bookmarks.list.table.never")}</span> : format.relativeTime(new Date(bookmark.lastOpenedAt)),
      sort: { direction: directionOf(sort, undefined, "recently_opened"), onSort: () => { onSort("recently_opened"); } },
    },
    {
      id: "added",
      header: t("bookmarks.list.table.added"),
      cell: (bookmark) => format.date(new Date(bookmark.createdAt), { dateStyle: "medium" }),
      sort: { direction: directionOf(sort, "oldest", "recent"), onSort: () => { onSort(sort === "recent" ? "oldest" : "recent"); } },
    },
    {
      id: "actions",
      header: t("bookmarks.list.table.actions"),
      hideHeader: true,
      cardSlot: "trailing",
      cell: (bookmark) => <ActionsCell bookmark={bookmark} onDelete={onDelete} onEdit={onEdit} onPin={onPin} onShare={onShare} pinPending={pendingPins.has(bookmark.id)} />,
    },
  ];
  return (
    <DataTable
      columns={columns}
      label={t("bookmarks.list.label")}
      rowKey={(bookmark) => bookmark.id}
      rowSelected={(bookmark) => selected.has(bookmark.id)}
      rows={bookmarks}
      selectionActive={selectionActive}
      {...(tabStopId === undefined ? {} : { tabStopId })}
    />
  );
}
