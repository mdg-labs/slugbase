import { Button } from "@slugbase/ui";
import { FilterXIcon, LayoutGridIcon, SegmentedChoice, SelectField, TableIcon } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { BOOKMARK_SORTS, DEFAULT_SORT, hasActiveFilters, type BookmarkListControls, type BookmarkListSearch, type BookmarkSort, type BookmarkView } from "./list-search.ts";

export interface BookmarksToolbarProps {
  /** The list's parameters, with the view the address or the account's default settles on. */
  readonly search: BookmarkListSearch & { readonly view: BookmarkView };
  readonly controls: BookmarkListControls;
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
 * default view, which applies to a list whose address names none (doc 02 section 2.1). The folder, tag and text filters arrive with their items.
 */
export function BookmarksToolbar({ search, controls }: BookmarksToolbarProps): ReactElement {
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
  const toggles = [
    { key: "pinned", label: t("bookmarks.list.filter.pinned"), on: search.pinned === true, toggle: (on: boolean) => { controls.update({ pinned: on ? undefined : true }); } },
    { key: "hasSlug", label: t("bookmarks.list.filter.hasSlug"), on: search.hasSlug === true, toggle: (on: boolean) => { controls.update({ hasSlug: on ? undefined : true }); } },
    { key: "forwarding", label: t("bookmarks.list.filter.forwarding"), on: search.forwarding === true, toggle: (on: boolean) => { controls.update({ forwarding: on ? undefined : true }); } },
  ];
  return (
    <section aria-label={t("bookmarks.list.toolbar")} className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
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
        <div aria-labelledby="bookmark-filters-label" className="flex flex-wrap gap-2" role="group">
          {toggles.map(({ key, label, on, toggle }) => (
            <Button
              aria-pressed={on}
              key={key}
              onClick={() => {
                toggle(on);
              }}
              size="sm"
              variant={on ? "secondary" : "outline"}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
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
    </section>
  );
}
