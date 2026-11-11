import { BOOKMARK_SCOPES } from "@slugbase/contracts";
import { Badge, Button } from "@slugbase/ui";
import { FilterXIcon, LayoutGridIcon, SegmentedChoice, SelectField, TableIcon } from "@slugbase/ui/patterns";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import type { AllFolders } from "../folders/use-all-folders.ts";
import { useSharingGranted } from "../sharing/index.ts";
import type { AllTags } from "../tags/use-all-tags.ts";
import { FilterChips, type FilterChip } from "./filter-chips.tsx";
import { FiltersPanel, type ShowOnlyFilter } from "./filters-panel.tsx";
import { BOOKMARK_SORTS, DEFAULT_SORT, type BookmarkListControls, type BookmarkListSearch, type BookmarkScope, type BookmarkSort, type BookmarkView } from "./list-search.ts";
import { SearchField } from "./search-field.tsx";

export interface BookmarksToolbarProps {
  /** The list's parameters, with the view the address or the account's default settles on. */
  readonly search: BookmarkListSearch & { readonly view: BookmarkView };
  readonly controls: BookmarkListControls;
  /** The member's folders, which the folder filter offers and names the folder chip from. */
  readonly folders: AllFolders;
  /** The folders other members shared with the member, which the folder filter offers and names the chip from after their own. */
  readonly shared: AllFolders;
  /** The member's tags, which the tags filter offers. */
  readonly tags: AllTags;
}

const ALL_SCOPE = "all";

// A segmented choice made as high as the buttons and selects beside it, with its label kept for assistive technology alone.
const COMPACT_SEGMENTS = "[&>span:first-child]:sr-only [&_[data-slot=segmented-choice-option]]:h-7.5 sm:[&_[data-slot=segmented-choice-option]]:h-6.5";

function isView(value: string): value is BookmarkView {
  return value === "grid" || value === "table";
}

function isScope(value: string): value is BookmarkScope {
  return (BOOKMARK_SCOPES as readonly string[]).includes(value);
}

function isSort(value: string): value is BookmarkSort {
  return (BOOKMARK_SORTS as readonly string[]).includes(value);
}

/**
 * The filters and the sort of the bookmark list (doc 03 section 3.1): one row of controls of one height, with no visible
 * labels (each keeps its name for assistive technology) in the order search, scope, Filters, sort, view. The Filters button
 * opens the panel with the folder, the tags and the "show only" switches and shows how many of them are set. Each control
 * writes to the address and reads back from it, so what is shown is what a link would open. The grid and table choice also
 * becomes the account's default view, which applies to a list whose address names none (doc 02 section 2.1). The search
 * field writes its text to the address once the member has stopped typing, with the history entry replaced, so the back
 * button leaves the list rather than undoing each word. Whatever narrows the list, the text of the search among it, is
 * also a chip under the row that takes it off, beside the button that takes them all off.
 */
export function BookmarksToolbar({ search, controls, folders, shared, tags }: BookmarksToolbarProps): ReactElement {
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
  // Shared bookmarks exist only where the workspace may share (doc 03 section 3.1), so the scopes about them are offered there alone.
  const sharingGranted = useSharingGranted();
  const scopeLabels = {
    all: t("bookmarks.list.scope.all"),
    mine: t("bookmarks.list.scope.mine"),
    shared_with_me: t("bookmarks.list.scope.sharedWithMe"),
    shared_by_me: t("bookmarks.list.scope.sharedByMe"),
  } as const satisfies Record<BookmarkScope, string>;
  const offeredScopes: readonly BookmarkScope[] = sharingGranted ? BOOKMARK_SCOPES : ["all", "mine"];
  const scopeOptions = offeredScopes.map((scope) => ({ value: scope, label: scopeLabels[scope] }));
  function changeScope(value: string): void {
    if (isScope(value)) {
      controls.update({ scope: value === ALL_SCOPE ? undefined : value });
    }
  }
  const showOnly = [
    { key: "pinned", label: t("bookmarks.list.filter.pinned") },
    { key: "hasSlug", label: t("bookmarks.list.filter.hasSlug") },
    { key: "forwarding", label: t("bookmarks.list.filter.forwarding") },
  ] as const satisfies readonly { key: ShowOnlyFilter; label: string }[];
  const [panelOpen, setPanelOpen] = useState(false);
  const filterFolders = [...folders.folders, ...shared.folders];
  const chosenFolder = filterFolders.find((folder) => folder.id === search.folderId);
  const tagIds = search.tag ?? [];
  const tagNames = new Map(tags.tags.map((tag) => [tag.id, tag.name]));
  // The filters the panel holds that are set now: the folder, each tag and each "show only" switch.
  const panelFilterCount = (search.folderId === undefined ? 0 : 1) + tagIds.length + showOnly.filter(({ key }) => search[key] === true).length;
  const chips: FilterChip[] = [
    ...(search.q === undefined
      ? []
      : [
          {
            id: "q",
            label: t("bookmarks.list.filters.queryChip", { text: search.q }),
            onRemove: () => {
              controls.update({ q: undefined });
            },
          },
        ]),
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
    ...tagIds.map((id) => {
      const name = tagNames.get(id);
      return {
        id: `tag-${id}`,
        label: name === undefined ? (tags.status === "ready" ? t("bookmarks.list.filters.tagChipUnknown") : t("bookmarks.list.filters.tags.pending")) : t("bookmarks.list.filters.tagChip", { name }),
        onRemove: () => {
          const rest = tagIds.filter((tagId) => tagId !== id);
          controls.update({ tag: rest.length === 0 ? undefined : rest });
        },
      };
    }),
    ...showOnly
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
            label: scopeLabels[search.scope],
            onRemove: () => {
              controls.update({ scope: undefined });
            },
          },
        ]),
  ];
  return (
    <section aria-label={t("bookmarks.list.toolbar")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          className="w-full sm:w-auto sm:min-w-48 sm:flex-1 [&_label]:sr-only"
          label={t("bookmarks.list.search.label")}
          onSearch={(text) => {
            controls.update({ q: text === "" ? undefined : text }, { replace: true });
          }}
          placeholder={t("bookmarks.list.search.placeholder")}
          value={search.q ?? ""}
        />
        <SegmentedChoice
          className={COMPACT_SEGMENTS}
          label={t("bookmarks.list.scope.label")}
          onValueChange={changeScope}
          options={scopeOptions}
          value={search.scope ?? ALL_SCOPE}
        />
        <Button
          {...(panelFilterCount === 0 ? {} : { "aria-label": t("bookmarks.list.filters.buttonCount", { count: panelFilterCount }) })}
          onClick={() => {
            setPanelOpen(true);
          }}
          type="button"
          variant="outline"
        >
          {t("bookmarks.list.filters.button")}
          {panelFilterCount === 0 ? null : (
            <Badge aria-hidden="true" size="lg" variant="secondary">
              {panelFilterCount}
            </Badge>
          )}
        </Button>
        <SelectField
          className="w-44 sm:w-48"
          hideLabel
          label={t("bookmarks.list.sort.label")}
          onValueChange={(value) => {
            if (isSort(value)) {
              controls.update({ sort: value === DEFAULT_SORT ? undefined : value });
            }
          }}
          options={sortOptions}
          value={search.sort ?? DEFAULT_SORT}
        />
        <SegmentedChoice className={`${COMPACT_SEGMENTS} ms-auto`} iconOnly label={t("bookmarks.list.view.label")} onValueChange={changeView} options={viewOptions} value={search.view} />
      </div>
      {chips.length === 0 ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FilterChips chips={chips} />
          <Button onClick={controls.clearFilters} size="sm" variant="ghost">
            <FilterXIcon aria-hidden="true" />
            {t("bookmarks.list.clearFilters")}
          </Button>
        </div>
      )}
      <FiltersPanel controls={controls} folders={folders} onOpenChange={setPanelOpen} open={panelOpen} search={search} shared={shared} tags={tags} />
    </section>
  );
}
