import { Tooltip, TooltipPopup, TooltipTrigger } from "@slugbase/ui";
import { StatusBadge } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { folderBackgroundClass } from "../folders/folder-glyph.tsx";
import type { Bookmark } from "./bookmarks.ts";

/** How many of a bookmark's tags its card and row show; the rest are counted (doc 03 section 3.2). */
export const TAGS_SHOWN = 3;

/**
 * A coloured dot for each folder the bookmark is filed in. A dot is named for assistive technology and names its folder in a
 * tooltip on hover and on focus. With `named` the name is also written beside the dot, where there is room for it (the table).
 */
export function FolderDots({ folders, named = false }: { readonly folders: Bookmark["folders"]; readonly named?: boolean }): ReactElement | null {
  if (folders.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {folders.map((folder) => (
        <span className="flex min-w-0 items-center gap-1.5" key={folder.id}>
          <Tooltip>
            <TooltipTrigger
              render={<span aria-label={folder.name} className={`size-2.5 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${folderBackgroundClass(folder.color)}`} role="img" tabIndex={0} />}
            />
            <TooltipPopup>
              <span translate="no">{folder.name}</span>
            </TooltipPopup>
          </Tooltip>
          {named ? (
            <span className="max-w-32 truncate text-sm" translate="no">
              {folder.name}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** The first three of the bookmark's own tags as text, and how many more there are. */
export function TagBadges({ tags }: { readonly tags: Bookmark["tags"] }): ReactElement | null {
  const { t } = useTranslation();
  if (tags.length === 0) {
    return null;
  }
  const hidden = tags.length - TAGS_SHOWN;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.slice(0, TAGS_SHOWN).map((tag) => (
        <StatusBadge className="max-w-32 truncate" key={tag.id}>
          <span className="truncate" translate="no">
            {tag.name}
          </span>
        </StatusBadge>
      ))}
      {hidden > 0 ? (
        <StatusBadge>
          <span aria-label={t("bookmarks.list.moreTags", { count: hidden })} role="img">
            {t("bookmarks.list.moreTagsShort", { count: hidden })}
          </span>
        </StatusBadge>
      ) : null}
    </span>
  );
}
