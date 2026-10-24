import { Button, Skeleton } from "@slugbase/ui";
import { Banner, CardGrid, Confirm, EmptyState, FilterXIcon, InboxIcon, Loading, LoadMore, PlusIcon } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { BookmarkCard } from "./bookmark-card.tsx";
import { BookmarksBulkBar } from "./bookmarks-bulk-bar.tsx";
import { BookmarksTable } from "./bookmarks-table.tsx";
import { useBulkBookmarks, usePendingPins, useDeleteBookmark, usePinBookmark } from "./bookmark-list-actions.ts";
import { useBookmarkSelection, useSelectionShortcuts } from "./bookmark-selection.ts";
import { bookmarkFailureOf, bookmarkListQuery, type Bookmark } from "./bookmarks.ts";
import { BookmarksToolbar } from "./bookmarks-toolbar.tsx";
import { BOOKMARK_PAGE_SIZES, DEFAULT_SORT, filterParamsOf, hasActiveFilters, listParamsOf, pageSizeOfSearch, useBookmarkListControls, useBookmarkListSearch, type BookmarkView } from "./list-search.ts";
import { useBookmarkModal } from "./modal-search.ts";
import { useListShortcuts } from "./use-list-shortcuts.ts";
import { usePasteToCreate } from "./use-paste-to-create.ts";

const SKELETON_CARDS = ["a", "b", "c", "d", "e", "f"] as const;

function CardsLoading({ view }: { readonly view: BookmarkView }): ReactElement {
  const { t } = useTranslation();
  return (
    <Loading className="p-0" label={t("bookmarks.list.loading")}>
      {view === "table" ? (
        <div className="flex flex-col gap-2">
          {SKELETON_CARDS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {SKELETON_CARDS.map((key) => (
            <Skeleton className="h-28 rounded-2xl" key={key} />
          ))}
        </div>
      )}
    </Loading>
  );
}

/**
 * `/bookmarks` (doc 03 section 3): the member's bookmarks as a grid of cards under the filters and the sort, which the
 * address holds. More are loaded with a button, a page of the chosen size at a time, and the count line says how many of
 * how many are shown. It also hosts the bookmark modal's paste handling: an address pasted onto the page becomes a new bookmark.
 */
export function BookmarksPage(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const search = useBookmarkListSearch();
  const controls = useBookmarkListControls();
  const modal = useBookmarkModal();
  usePasteToCreate(modal.openNew);

  const query = useInfiniteQuery(bookmarkListQuery(router.options.context.api, listParamsOf(search)));
  const pin = usePinBookmark();
  const pendingPins = usePendingPins();
  const [deleting, setDeleting] = useState<Bookmark | undefined>(undefined);
  const filters = filterParamsOf(search);
  // The selection belongs to the filters it was made under; the sort, the view and the size do not change which bookmarks match.
  const selection = useBookmarkSelection(JSON.stringify(filters));
  const bulk = useBulkBookmarks(selection);
  const remove = useDeleteBookmark(() => {
    if (deleting !== undefined) {
      selection.toggle(deleting.id, false);
    }
    setDeleting(undefined);
  });

  const startDelete = (target: Bookmark): void => {
    remove.reset();
    setDeleting(target);
  };
  const selectBookmark = (target: Bookmark, selected: boolean): void => {
    selection.toggle(target.id, selected);
  };
  const editBookmark = (target: Bookmark): void => {
    modal.edit(target.id);
  };

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const lastPage = query.data?.pages.at(-1);
  useSelectionShortcuts(
    selection,
    items.map((bookmark) => bookmark.id),
  );
  const filtered = hasActiveFilters(search);
  const navigation = useListShortcuts({ items, view: search.view, selection, filtered, controls, modal, pin: pin.pin, pendingPins });
  const newBookmark = (
    <Button
      onClick={() => {
        modal.openNew();
      }}
    >
      <PlusIcon aria-hidden="true" />
      {t("bookmarks.new")}
    </Button>
  );

  const heading = <h1 className="font-semibold text-2xl leading-none">{t("bookmarks.page.title")}</h1>;
  if (query.data !== undefined && items.length === 0 && !query.hasNextPage && !filtered) {
    return (
      <>
        {heading}
        <EmptyState
          actions={newBookmark}
          description={t("bookmarks.list.empty.description")}
          headingLevel={2}
          icon={<InboxIcon aria-hidden="true" />}
          title={t("bookmarks.list.empty.title")}
        />
      </>
    );
  }

  let body: ReactElement;
  if (query.isPending) {
    body = <CardsLoading view={search.view} />;
  } else if (query.data === undefined) {
    body = (
      <Banner
        action={
          <Button
            loading={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("bookmarks.list.retry")}
          </Button>
        }
        title={t("bookmarks.list.loadFailed")}
        variant="error"
      />
    );
  } else if (items.length === 0 && !query.hasNextPage) {
    body = (
      <EmptyState
        actions={
          <Button onClick={controls.clearFilters} variant="outline">
            <FilterXIcon aria-hidden="true" />
            {t("bookmarks.list.clearFilters")}
          </Button>
        }
        icon={<FilterXIcon aria-hidden="true" />}
        title={t("bookmarks.list.noMatch")}
      />
    );
  } else {
    const shown = format.number(items.length);
    const total = lastPage?.total;
    body = (
      <>
        {query.isError ? (
          <Banner
            action={
              <Button
                loading={query.isFetching}
                onClick={() => {
                  void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
                }}
                size="sm"
                variant="outline"
              >
                {t("bookmarks.list.retry")}
              </Button>
            }
            title={query.isFetchNextPageError ? t("bookmarks.list.loadMoreFailed") : t("bookmarks.list.refreshFailed")}
            variant="error"
          />
        ) : null}
        <div onFocus={navigation.onFocus} ref={navigation.ref}>
          {search.view === "table" ? (
            <BookmarksTable
              bookmarks={items}
              onDelete={startDelete}
              onEdit={editBookmark}
              onPin={pin.pin}
              onSelectedChange={selectBookmark}
              onSort={(sort) => {
                controls.update({ sort: sort === DEFAULT_SORT ? undefined : sort });
              }}
              pendingPins={pendingPins}
              selected={selection.ids}
              selectionActive={selection.ids.size > 0}
              sort={search.sort}
              tabStopId={navigation.tabStopId}
            />
          ) : (
            <CardGrid label={t("bookmarks.list.label")} selectionActive={selection.ids.size > 0}>
              {items.map((bookmark) => (
                <BookmarkCard
                  bookmark={bookmark}
                  key={bookmark.id}
                  onDelete={startDelete}
                  onEdit={editBookmark}
                  onPin={pin.pin}
                  onSelectedChange={selectBookmark}
                  pinPending={pendingPins.has(bookmark.id)}
                  selected={selection.has(bookmark.id)}
                  selectionActive={selection.ids.size > 0}
                  tabStop={bookmark.id === navigation.tabStopId}
                />
              ))}
            </CardGrid>
          )}
        </div>
        <LoadMore
          count={
            lastPage?.totalAtLeast !== undefined && total === null
              ? t("bookmarks.list.countAtLeast", { shown, total: format.number(lastPage.totalAtLeast) })
              : t("bookmarks.list.count", { shown, total: format.number(total ?? items.length) })
          }
          hasMore={query.hasNextPage}
          loadMoreLabel={t("bookmarks.list.loadMore")}
          loading={query.isFetchingNextPage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
          pageSize={{
            label: t("bookmarks.list.pageSize"),
            value: String(pageSizeOfSearch(search)),
            options: BOOKMARK_PAGE_SIZES.map((size) => ({ value: String(size), label: format.number(size) })),
            onValueChange: (value) => {
              controls.update({ size: BOOKMARK_PAGE_SIZES.find((size) => String(size) === value) });
            },
          }}
        />
      </>
    );
  }

  return (
    <>
      {heading}
      <BookmarksToolbar controls={controls} search={search} />
      {body}
      <BookmarksBulkBar bulk={bulk} filters={filters} selection={selection} total={lastPage?.total ?? null} />
      <p aria-live="polite" className="sr-only" role="status">
        {bulk.announcement}
      </p>
      <Confirm
        cancelLabel={t("bookmarks.list.delete.cancel")}
        confirmLabel={t("bookmarks.list.delete.confirm")}
        description={
          <>
            {deleting?.slug == null
              ? t("bookmarks.list.delete.description", { title: deleting?.title ?? "" })
              : t("bookmarks.list.delete.descriptionSlug", { title: deleting.title })}
            {remove.isError ? (
              <span className="mt-3 block text-destructive-text" role="alert">
                {bookmarkFailureOf(remove.error)?.kind === "notFound" ? t("bookmarks.list.delete.error.notFound") : t("bookmarks.list.delete.error.unavailable")}
              </span>
            ) : null}
          </>
        }
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting !== undefined) {
            remove.mutate(deleting.id);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined);
          }
        }}
        open={deleting !== undefined}
        title={t("bookmarks.list.delete.title")}
      />
    </>
  );
}
