import { Button } from "@slugbase/ui";
import { CheckboxField, MultiPick, Picker, SidePanel } from "@slugbase/ui/patterns";
import { useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { folderIconOf, folderTextClass } from "../folders/folder-glyph.tsx";
import type { AllFolders } from "../folders/use-all-folders.ts";
import type { AllTags } from "../tags/use-all-tags.ts";
import { BOOKMARK_TAG_FILTER_MAX, type BookmarkListControls, type BookmarkListSearch } from "./list-search.ts";

/** The "show only" switches of the list and the address parameter each one writes. */
export const SHOW_ONLY_FILTERS = ["pinned", "hasSlug", "forwarding"] as const;

export type ShowOnlyFilter = (typeof SHOW_ONLY_FILTERS)[number];

export interface FiltersPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly search: BookmarkListSearch;
  readonly controls: BookmarkListControls;
  /** The member's folders and the folders shared with them, which the folder filter offers and names the chip from. */
  readonly folders: AllFolders;
  readonly shared: AllFolders;
  readonly tags: AllTags;
}

/**
 * The filters that do not fit in the toolbar row (doc 03 section 3.1): the folder, the tags and what to show only.
 * They sit in a side panel that opens from the Filters button; each one writes to the address as it is changed, so the
 * list narrows while the panel is open and a link opens the same filters. A folder or tag list that could not be read
 * says so and can be read again, and is never shown as having none.
 */
export function FiltersPanel({ open, onOpenChange, search, controls, folders, shared, tags }: FiltersPanelProps): ReactElement {
  const { t } = useTranslation();
  const showOnlyId = useId();
  const showOnly = {
    pinned: t("bookmarks.list.filter.pinned"),
    hasSlug: t("bookmarks.list.filter.hasSlug"),
    forwarding: t("bookmarks.list.filter.forwarding"),
  } as const satisfies Record<ShowOnlyFilter, string>;
  const filterFolders = [...folders.folders, ...shared.folders];
  const folderOptions = filterFolders.map((folder) => {
    const Icon = folderIconOf(folder.icon);
    return { value: folder.id, label: folder.name, icon: <Icon className={`size-4 ${folderTextClass(folder.color)}`} /> };
  });
  const tagIds = search.tag ?? [];
  // A tag of the address that the member's list lacks (deleted, or never theirs) is still shown, so it can be taken off.
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
  return (
    <SidePanel closeLabel={t("bookmarks.list.filters.close")} onOpenChange={onOpenChange} open={open} title={t("bookmarks.list.filters.title")}>
      <div className="flex flex-col gap-5">
        <Picker
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
        <div aria-labelledby={showOnlyId} className="flex flex-col gap-3" role="group">
          <span className="font-medium text-base/4.5 text-foreground sm:text-sm/4" id={showOnlyId}>
            {t("bookmarks.list.filter.label")}
          </span>
          {SHOW_ONLY_FILTERS.map((key) => (
            <CheckboxField
              checked={search[key] === true}
              key={key}
              label={showOnly[key]}
              onCheckedChange={(checked) => {
                controls.update({ [key]: checked ? true : undefined });
              }}
            />
          ))}
        </div>
      </div>
    </SidePanel>
  );
}
