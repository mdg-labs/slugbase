import { StatusBadge } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { folderBackgroundClass } from "../folders/folder-glyph.tsx";
import type { Bookmark } from "./bookmarks.ts";

/** How many of a bookmark's tags its card and row show; the rest are counted (doc 03 section 3.2). */
export const TAGS_SHOWN = 3;

/** A coloured dot for each folder the bookmark is filed in, named for assistive technology and on hover. */
export function FolderDots({ folders }: { readonly folders: Bookmark["folders"] }): ReactElement | null {
  if (folders.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {folders.map((folder) => (
        <span aria-label={folder.name} className={`size-2.5 shrink-0 rounded-full ${folderBackgroundClass(folder.color)}`} key={folder.id} role="img" title={folder.name} />
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
