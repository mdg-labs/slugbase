import { Button, Skeleton } from "@slugbase/ui";
import { Banner, CardGrid, Confirm, EmptyState, FilterXIcon, InboxIcon, Loading, LoadMore, PlusIcon } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAllFolders } from "../folders/use-all-folders.ts";
import { useFormat } from "../i18n/use-format.ts";
import { ShareDialog, type ShareSubject } from "../sharing/index.ts";
import { useAllTags } from "../tags/use-all-tags.ts";
import { BookmarkCard } from "./bookmark-card.tsx";
import { BookmarksBulkBar } from "./bookmarks-bulk-bar.tsx";
import { BookmarksTable } from "./bookmarks-table.tsx";
import { useBulkBookmarks, usePendingPins, useDeleteBookmark, usePinBookmark } from "./bookmark-list-actions.ts";
import { useBookmarkSelection, useSelectionShortcuts } from "./bookmark-selection.ts";
import { bookmarkFailureOf, bookmarkListQuery, type Bookmark } from "./bookmarks.ts";
import { BookmarksToolbar } from "./bookmarks-toolbar.tsx";
import { BOOKMARK_PAGE_SIZES, DEFAULT_SORT, filterParamsOf, hasActiveFilters, listParamsOf, pageSizeOfSearch, useBookmarkListControls, useBookmarkListSearch, withoutFolder, type BookmarkListSearch, type BookmarkView } from "./list-search.ts";
import { useBookmarkModal } from "./modal-search.ts";
import { useListShortcuts } from "./use-list-shortcuts.ts";
import { usePasteToCreate } from "./use-paste-to-create.ts";

// The shell's main area has no padding of its own: each page keeps its content off the edges, as the settings and admin layouts do.
const PAGE_FRAME = "flex w-full min-w-0 flex-col gap-4 p-4 md:p-6";

const SKELETON_CARDS = ["a", "b", "c", "d", "e", "f"] as const;

// Whether the scope is the only filter of the list.
function onlyScope(search: BookmarkListSearch): boolean {
  const rest = { ...search };
  Reflect.deleteProperty(rest, "scope");
  return !hasActiveFilters(rest);
}

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
  const addressed = useBookmarkListSearch();
  const controls = useBookmarkListControls();
  const modal = useBookmarkModal();
  usePasteToCreate(modal.openNew);
  const folders = useAllFolders();
  const tags = useAllTags();
  // A folder of the address is concluded not to be the member's only from a whole list; a list that failed or is still
  // loading says nothing about it. The list held may predate the folder (made on another device, say), so a folder missing
  // from it is looked for once more in a fresh read, and only a folder still missing then is taken for one that is gone.
  const missingFolder = addressed.folderId !== undefined && folders.status === "ready" && !folders.folders.some((folder) => folder.id === addressed.folderId);
  const [rereadFor, setRereadFor] = useState<string | undefined>(undefined);
  const { reread } = folders;
  useEffect(() => {
    const folderId = addressed.folderId;
    if (!missingFolder || folderId === undefined || rereadFor === folderId) {
      return undefined;
    }
    let current = true;
    void reread().then(() => {
      if (current) {
        setRereadFor(folderId);
      }
    });
    return () => {
      current = false;
    };
  }, [missingFolder, rereadFor, addressed.folderId, reread]);
  const staleFolder = missingFolder && rereadFor === addressed.folderId;
  // A folder the member does not have is not applied: the list is not narrowed by what they cannot see or remove.
  const search = staleFolder ? { ...withoutFolder(addressed), view: addressed.view } : addressed;
  const [staleNotice, setStaleNotice] = useState(false);
  useEffect(() => {
    if (staleFolder) {
      setStaleNotice(true);
      // Replacing the entry keeps back from returning to an address that is cleared again at once.
      controls.update({ folderId: undefined }, { replace: true });
    }
  }, [staleFolder, controls]);

  const query = useInfiniteQuery(bookmarkListQuery(router.options.context.api, listParamsOf(search)));
  const pin = usePinBookmark();
  const pendingPins = usePendingPins();
  const [deleting, setDeleting] = useState<Bookmark | undefined>(undefined);
  const [sharing, setSharing] = useState<ShareSubject | undefined>(undefined);
  const filters = filterParamsOf(search);
  // The selection belongs to the filters it was made under, the folder and the tags included; the sort, the view and the size do not change which bookmarks match.
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
  const shareBookmark = (target: Bookmark): void => {
    setSharing({ kind: "bookmark", id: target.id, name: target.title });
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
      <div className={PAGE_FRAME}>
        {heading}
        <EmptyState
          actions={newBookmark}
          description={t("bookmarks.list.empty.description")}
          headingLevel={2}
          icon={<InboxIcon aria-hidden="true" />}
          title={t("bookmarks.list.empty.title")}
        />
      </div>
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
  } else if (items.length === 0 && !query.hasNextPage && search.scope === "shared_with_me" && onlyScope(search)) {
    // The member has filtered nothing but the scope, so the list is empty because nothing has been shared with them (doc 03 section 3.5).
    body = (
      <EmptyState
        actions={
          <Button onClick={controls.clearFilters} variant="outline">
            <FilterXIcon aria-hidden="true" />
            {t("bookmarks.list.clearFilters")}
          </Button>
        }
        description={t("bookmarks.list.empty.sharedWithMe.description")}
        icon={<InboxIcon aria-hidden="true" />}
        title={t("bookmarks.list.empty.sharedWithMe.title")}
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
              onShare={shareBookmark}
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
                  onShare={shareBookmark}
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
    <div className={PAGE_FRAME}>
      {heading}
      {staleNotice ? (
        <Banner
          action={
            <Button
              onClick={() => {
                setStaleNotice(false);
              }}
              size="sm"
              variant="outline"
            >
              {t("bookmarks.list.filters.staleFolder.dismiss")}
            </Button>
          }
          description={t("bookmarks.list.filters.staleFolder.description")}
          title={t("bookmarks.list.filters.staleFolder.title")}
          variant="warning"
        />
      ) : null}
      <BookmarksToolbar controls={controls} folders={folders} search={search} tags={tags} />
      {body}
      <BookmarksBulkBar bulk={bulk} filters={filters} items={items} selection={selection} total={lastPage?.total ?? null} />
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
      {sharing === undefined ? null : (
        <ShareDialog
          onClose={() => {
            setSharing(undefined);
          }}
          subject={sharing}
        />
      )}
    </div>
  );
}
