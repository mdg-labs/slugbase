import { DataTable, Favicon, PinIcon, RowActions, SelectCheckbox, type DataTableColumn, type DataTableSortDirection } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useRef, type ReactElement } from "react";
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

/**
 * A bookmark with what its row shows besides it. A row is drawn again only when its model is a new object, so a model
 * is kept while the bookmark, its selection and its pending pin are the same (`useRowModels`).
 */
interface RowModel {
  readonly bookmark: Bookmark;
  readonly selected: boolean;
  readonly pinPending: boolean;
}

function useRowModels(bookmarks: readonly Bookmark[], selected: ReadonlySet<string>, pendingPins: ReadonlySet<string>): readonly RowModel[] {
  const kept = useRef<ReadonlyMap<string, RowModel>>(new Map());
  const models = useMemo(
    () =>
      bookmarks.map((bookmark): RowModel => {
        const before = kept.current.get(bookmark.id);
        const isSelected = selected.has(bookmark.id);
        const pinPending = pendingPins.has(bookmark.id);
        return before?.bookmark === bookmark && before.selected === isSelected && before.pinPending === pinPending ? before : { bookmark, selected: isSelected, pinPending };
      }),
    [bookmarks, selected, pendingPins],
  );
  useLayoutEffect(() => {
    kept.current = new Map(models.map((model) => [model.bookmark.id, model]));
  }, [models]);
  return models;
}

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
 * folders column shows a dot and the name of each folder and the tags column the first three tags. A selection, a pin
 * being saved or a new tab stop draws the rows it changes and no others: the columns are kept from one render to the
 * next and reach the page's handlers through a ref, so only a row whose bookmark, selection or pending pin changed is new.
 */
export function BookmarksTable(props: BookmarksTableProps): ReactElement {
  const { bookmarks, pendingPins, sort: current, selected, selectionActive, tabStopId } = props;
  const { t } = useTranslation();
  const format = useFormat();
  const sort = current ?? DEFAULT_SORT;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const onSelectedChange = useCallback((bookmark: Bookmark, next: boolean): void => {
    latest.current.onSelectedChange(bookmark, next);
  }, []);
  const onEdit = useCallback((bookmark: Bookmark): void => {
    latest.current.onEdit(bookmark);
  }, []);
  const onPin = useCallback((bookmark: Bookmark, pinned: boolean): void => {
    latest.current.onPin(bookmark, pinned);
  }, []);
  const onShare = useCallback((bookmark: Bookmark): void => {
    latest.current.onShare(bookmark);
  }, []);
  const onDelete = useCallback((bookmark: Bookmark): void => {
    latest.current.onDelete(bookmark);
  }, []);
  const onSort = useCallback((next: BookmarkSort): void => {
    latest.current.onSort(next);
  }, []);
  const rows = useRowModels(bookmarks, selected, pendingPins);
  const columns = useMemo<readonly DataTableColumn<RowModel>[]>(
    () => [
      {
        id: "select",
        header: t("bookmarks.list.table.select"),
        hideHeader: true,
        cardSlot: "leading",
        cell: ({ bookmark, selected: checked }) => (
          <SelectCheckbox
            checked={checked}
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
        cell: ({ bookmark }) => <TitleCell bookmark={bookmark} />,
        sort: { direction: directionOf(sort, "title_asc", "title_desc"), onSort: () => { onSort(sort === "title_asc" ? "title_desc" : "title_asc"); } },
      },
      {
        id: "slug",
        header: t("bookmarks.list.table.slug"),
        cell: ({ bookmark }) =>
          bookmark.slug === null ? null : (
            <span className="font-mono text-xs" translate="no">
              {`/go/${bookmark.slug}`}
            </span>
          ),
      },
      {
        id: "host",
        header: t("bookmarks.list.table.host"),
        cell: ({ bookmark }) => (
          <span className="block max-w-48 truncate font-mono text-muted-foreground text-xs" translate="no">
            {bookmark.host}
          </span>
        ),
      },
      { id: "folders", header: t("bookmarks.list.table.folders"), cell: ({ bookmark }) => <FolderDots folders={bookmark.folders} named /> },
      { id: "tags", header: t("bookmarks.list.table.tags"), cell: ({ bookmark }) => <TagBadges tags={bookmark.tags} /> },
      {
        id: "opens",
        header: t("bookmarks.list.table.opens"),
        cell: ({ bookmark }) => format.number(bookmark.openCount),
        sort: { direction: directionOf(sort, undefined, "most_used"), onSort: () => { onSort("most_used"); } },
      },
      {
        id: "lastOpened",
        header: t("bookmarks.list.table.lastOpened"),
        cell: ({ bookmark }) =>
          bookmark.lastOpenedAt === null ? <span className="text-muted-foreground">{t("bookmarks.list.table.never")}</span> : format.relativeTime(new Date(bookmark.lastOpenedAt)),
        sort: { direction: directionOf(sort, undefined, "recently_opened"), onSort: () => { onSort("recently_opened"); } },
      },
      {
        id: "added",
        header: t("bookmarks.list.table.added"),
        cell: ({ bookmark }) => format.date(new Date(bookmark.createdAt), { dateStyle: "medium" }),
        sort: { direction: directionOf(sort, "oldest", "recent"), onSort: () => { onSort(sort === "recent" ? "oldest" : "recent"); } },
      },
      {
        id: "actions",
        header: t("bookmarks.list.table.actions"),
        hideHeader: true,
        cardSlot: "trailing",
        cell: ({ bookmark, pinPending }) => <ActionsCell bookmark={bookmark} onDelete={onDelete} onEdit={onEdit} onPin={onPin} onShare={onShare} pinPending={pinPending} />,
      },
    ],
    [t, format, sort, onSelectedChange, onEdit, onPin, onShare, onDelete, onSort],
  );
  return (
    <DataTable
      columns={columns}
      label={t("bookmarks.list.label")}
      rowKey={(row) => row.bookmark.id}
      rowSelected={(row) => row.selected}
      rows={rows}
      selectionActive={selectionActive}
      {...(tabStopId === undefined ? {} : { tabStopId })}
    />
  );
}
