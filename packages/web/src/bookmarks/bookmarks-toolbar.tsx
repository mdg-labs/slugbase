import { Button, ToggleGroup, ToggleGroupItem } from "@slugbase/ui";
import { FilterXIcon, LayoutGridIcon, MultiPick, Picker, SegmentedChoice, SelectField, TableIcon } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { folderIconOf, folderTextClass } from "../folders/folder-glyph.tsx";
import type { AllFolders } from "../folders/use-all-folders.ts";
import type { AllTags } from "../tags/use-all-tags.ts";
import { FilterChips, type FilterChip } from "./filter-chips.tsx";
import { BOOKMARK_SORTS, BOOKMARK_TAG_FILTER_MAX, DEFAULT_SORT, hasActiveFilters, type BookmarkListControls, type BookmarkListSearch, type BookmarkSort, type BookmarkView } from "./list-search.ts";

export interface BookmarksToolbarProps {
  /** The list's parameters, with the view the address or the account's default settles on. */
  readonly search: BookmarkListSearch & { readonly view: BookmarkView };
  readonly controls: BookmarkListControls;
  /** The member's folders, which the folder filter offers and names the folder chip from. */
  readonly folders: AllFolders;
  /** The member's tags, which the tags filter offers. */
  readonly tags: AllTags;
}

const ALL_SCOPE = "all";
const MINE_SCOPE = "mine";

function isView(value: string): value is BookmarkView {
  return value === "grid" || value === "table";
}

function isSort(value: string): value is BookmarkSort {
  return (BOOKMARK_SORTS as readonly string[]).includes(value);
}

/**
 * The filters and the sort of the bookmark list (doc 03 section 3.1). Each control writes to the address and reads
 * back from it, so what is shown is what a link would open. The grid and table choice also becomes the account's
 * default view, which applies to a list whose address names none (doc 02 section 2.1). The folder filter is a single
 * choice and the tags filter several, which a bookmark must all carry; a list of either that could not be read says so
 * and can be read again, and is never shown as having none. Whatever narrows the list is also a chip that takes it off.
 * The text filter arrives with its item.
 */
export function BookmarksToolbar({ search, controls, folders, tags }: BookmarksToolbarProps): ReactElement {
  const { t } = useTranslation();
  const account = useCachedAccount();
  const preferences = useUpdatePreferences();
  const viewOptions = [
    { value: "grid", label: t("bookmarks.list.view.grid"), icon: <LayoutGridIcon aria-hidden="true" className="size-4" /> },
    { value: "table", label: t("bookmarks.list.view.table"), icon: <TableIcon aria-hidden="true" className="size-4" /> },
  ];
  function changeView(value: string): void {
    if (!isView(value)) {
      return;
    }
    controls.update({ view: value });
    // A failed save is reported by the app's mutation handler and leaves the account's default as it was.
    if (account?.defaultView !== value) {
      preferences.mutate({ defaultView: value });
    }
  }
  const sortOptions = [
    { value: "recent", label: t("bookmarks.list.sort.recent") },
    { value: "oldest", label: t("bookmarks.list.sort.oldest") },
    { value: "title_asc", label: t("bookmarks.list.sort.titleAsc") },
    { value: "title_desc", label: t("bookmarks.list.sort.titleDesc") },
    { value: "most_used", label: t("bookmarks.list.sort.mostUsed") },
    { value: "recently_opened", label: t("bookmarks.list.sort.recentlyOpened") },
  ] as const satisfies readonly { value: BookmarkSort; label: string }[];
  const scopeOptions = [
    { value: ALL_SCOPE, label: t("bookmarks.list.scope.all") },
    { value: MINE_SCOPE, label: t("bookmarks.list.scope.mine") },
  ];
  function changeScope(value: string): void {
    controls.update({ scope: value === MINE_SCOPE ? MINE_SCOPE : undefined });
  }
  const filters = [
    { key: "pinned", label: t("bookmarks.list.filter.pinned") },
    { key: "hasSlug", label: t("bookmarks.list.filter.hasSlug") },
    { key: "forwarding", label: t("bookmarks.list.filter.forwarding") },
  ] as const;
  const activeFilters = filters.filter(({ key }) => search[key] === true).map(({ key }) => key);
  function changeFilters(active: readonly string[]): void {
    controls.update({
      pinned: active.includes("pinned") ? true : undefined,
      hasSlug: active.includes("hasSlug") ? true : undefined,
      forwarding: active.includes("forwarding") ? true : undefined,
    });
  }
  const folderOptions = folders.folders.map((folder) => {
    const Icon = folderIconOf(folder.icon);
    return { value: folder.id, label: folder.name, icon: <Icon className={`size-4 ${folderTextClass(folder.color)}`} /> };
  });
  const chosenFolder = folders.folders.find((folder) => folder.id === search.folderId);
  const tagIds = search.tag ?? [];
  // A tag of the address that the member's list lacks (deleted, or never theirs) still has its chip, so it can be taken off.
  const unlisted = tagIds.filter((id) => !tags.tags.some((tag) => tag.id === id));
  const tagOptions = [
    ...tags.tags.map((tag) => ({ value: tag.id, label: tag.name })),
    ...unlisted.map((id) => ({ value: id, label: tags.status === "ready" ? t("bookmarks.list.filters.tags.unknown") : t("bookmarks.list.filters.tags.pending") })),
  ];
  const retry = (message: string, state: AllFolders | AllTags): ReactElement => (
    <span className="flex flex-wrap items-center gap-x-2">
      {message}
      <Button loading={state.retrying} onClick={state.retry} size="xs" type="button" variant="outline">
        {t("bookmarks.list.retry")}
      </Button>
    </span>
  );
  const chips: FilterChip[] = [
    ...(search.folderId === undefined
      ? []
      : [
          {
            id: "folder",
            label: chosenFolder === undefined ? t("bookmarks.list.filters.folderChipUnknown") : t("bookmarks.list.filters.folderChip", { name: chosenFolder.name }),
            onRemove: () => {
              controls.update({ folderId: undefined });
            },
          },
        ]),
    ...filters
      .filter(({ key }) => search[key] === true)
      .map(({ key, label }) => ({
        id: key,
        label,
        onRemove: () => {
          controls.update({ [key]: undefined });
        },
      })),
    ...(search.scope === undefined
      ? []
      : [
          {
            id: "scope",
            label: t("bookmarks.list.scope.mine"),
            onRemove: () => {
              controls.update({ scope: undefined });
            },
          },
        ]),
  ];
  return (
    <section aria-label={t("bookmarks.list.toolbar")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
        <SegmentedChoice label={t("bookmarks.list.view.label")} onValueChange={changeView} options={viewOptions} value={search.view} />
        <SegmentedChoice
          label={t("bookmarks.list.scope.label")}
          onValueChange={changeScope}
          options={scopeOptions}
          value={search.scope ?? ALL_SCOPE}
        />
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-base/4.5 text-foreground sm:text-sm/4" id="bookmark-filters-label">
            {t("bookmarks.list.filter.label")}
          </span>
          <ToggleGroup aria-labelledby="bookmark-filters-label" multiple onValueChange={changeFilters} size="sm" value={activeFilters} variant="outline">
            {filters.map(({ key, label }) => (
              <ToggleGroupItem key={key} value={key}>
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <Picker
          className="sm:w-52"
          description={folders.status === "failed" ? retry(t("bookmarks.list.filters.folder.loadFailed"), folders) : undefined}
          emptyLabel={t("bookmarks.list.filters.folder.empty")}
          label={t("bookmarks.list.filters.folder.label")}
          {...(folders.status === "loading" ? { loadingLabel: t("bookmarks.list.filters.folder.loading") } : {})}
          {...(folders.status === "failed" ? { unavailableLabel: t("bookmarks.list.filters.folder.loadFailed") } : {})}
          onValueChange={(id) => {
            controls.update({ folderId: id });
          }}
          options={folderOptions}
          placeholder={t("bookmarks.list.filters.folder.placeholder")}
          value={search.folderId}
        />
        <MultiPick
          className="sm:w-72"
          description={tags.status === "failed" ? retry(t("bookmarks.list.filters.tags.loadFailed"), tags) : t("bookmarks.list.filters.tags.limit", { max: BOOKMARK_TAG_FILTER_MAX })}
          emptyLabel={t("bookmarks.list.filters.tags.empty")}
          label={t("bookmarks.list.filters.tags.label")}
          {...(tags.status === "loading" ? { loadingLabel: t("bookmarks.list.filters.tags.loading") } : {})}
          {...(tags.status === "failed" ? { unavailableLabel: t("bookmarks.list.filters.tags.loadFailed") } : {})}
          onValueChange={(ids) => {
            controls.update({ tag: ids.length === 0 ? undefined : ids.slice(0, BOOKMARK_TAG_FILTER_MAX) });
          }}
          options={tagOptions}
          placeholder={t("bookmarks.list.filters.tags.placeholder")}
          removeLabel={(name) => t("bookmarks.list.filters.tags.remove", { name })}
          value={tagIds}
        />
        <SelectField
          className="sm:w-48"
          label={t("bookmarks.list.sort.label")}
          onValueChange={(value) => {
            if (isSort(value)) {
              controls.update({ sort: value === DEFAULT_SORT ? undefined : value });
            }
          }}
          options={sortOptions}
          value={search.sort ?? DEFAULT_SORT}
        />
        {hasActiveFilters(search) ? (
          <Button onClick={controls.clearFilters} size="sm" variant="ghost">
            <FilterXIcon aria-hidden="true" />
            {t("bookmarks.list.clearFilters")}
          </Button>
        ) : null}
      </div>
      <FilterChips chips={chips} />
    </section>
  );
}
