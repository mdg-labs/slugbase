import { CardGridItem, PencilIcon, PinIcon, PinOffIcon, Share2Icon, Trash2Icon, type RowAction } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { useIsOwner, useSharingGranted } from "../sharing/index.ts";
import { FolderDots, TagBadges } from "./bookmark-labels.tsx";
import { isHttpUrl, recordOpen, type Bookmark } from "./bookmarks.ts";

export interface BookmarkActionHandlers {
  readonly bookmark: Bookmark;
  /** Whether a pin or unpin of this bookmark is being saved; a second one waits for it. */
  readonly pinPending: boolean;
  readonly onEdit: (bookmark: Bookmark) => void;
  readonly onPin: (bookmark: Bookmark, pinned: boolean) => void;
  readonly onShare: (bookmark: Bookmark) => void;
  readonly onDelete: (bookmark: Bookmark) => void;
}

export type BookmarkCardProps = BookmarkActionHandlers & {
  readonly selected: boolean;
  /** Whether any bookmark of the list is selected, which keeps every card's checkbox in view. */
  readonly selectionActive: boolean;
  /** Whether this card is the list's one stop on the Tab key. */
  readonly tabStop: boolean;
  readonly onSelectedChange: (bookmark: Bookmark, selected: boolean) => void;
};

/** The actions of one bookmark, which its card and its table row show as one list. */
export function useBookmarkActions({ bookmark, pinPending, onEdit, onPin, onShare, onDelete }: BookmarkActionHandlers): readonly RowAction[] {
  const { t } = useTranslation();
  // Only the owner shares a bookmark, and only a workspace that may share offers the action.
  const sharingGranted = useSharingGranted();
  const owned = useIsOwner(bookmark.ownerId);
  const shareable = sharingGranted && owned;
  return [
    { id: "edit", label: t("bookmarks.list.edit"), icon: <PencilIcon aria-hidden="true" />, onSelect: () => { onEdit(bookmark); } },
    ...(shareable ? [{ id: "share", label: t("bookmarks.list.share"), icon: <Share2Icon aria-hidden="true" />, onSelect: () => { onShare(bookmark); } }] : []),
    bookmark.pinned
      ? { id: "unpin", label: t("bookmarks.list.unpin"), icon: <PinOffIcon aria-hidden="true" />, disabled: pinPending, onSelect: () => { onPin(bookmark, false); } }
      : { id: "pin", label: t("bookmarks.list.pin.action"), icon: <PinIcon aria-hidden="true" />, disabled: pinPending, onSelect: () => { onPin(bookmark, true); } },
    { id: "delete", label: t("bookmarks.list.delete.action"), icon: <Trash2Icon aria-hidden="true" />, destructive: true, onSelect: () => { onDelete(bookmark); } },
  ];
}

/**
 * One bookmark of the grid (doc 03 section 3.2). The title, host and slug are shown as text, whatever they hold. The
 * title follows the bookmark's address in the same tab, and only when that is an `http` or `https` address (T14); the
 * open is counted without waiting for the answer. The menu button and the context menu show one list of actions.
 */
export function BookmarkCard({ bookmark, pinPending, selected, selectionActive, tabStop, onEdit, onPin, onShare, onDelete, onSelectedChange }: BookmarkCardProps): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  let usage: string;
  if (bookmark.openCount === 0) {
    usage = t("bookmarks.list.neverOpened");
  } else if (bookmark.lastOpenedAt === null) {
    usage = t("bookmarks.list.opens", { count: bookmark.openCount });
  } else {
    usage = t("bookmarks.list.usage", { count: bookmark.openCount, when: format.relativeTime(new Date(bookmark.lastOpenedAt)) });
  }
  const actions = useBookmarkActions({ bookmark, pinPending, onEdit, onPin, onShare, onDelete });
  return (
    <CardGridItem
      actions={actions}
      actionsLabel={t("bookmarks.list.actionsFor", { title: bookmark.title })}
      {...(isHttpUrl(bookmark.url) ? { href: bookmark.url } : {})}
      itemId={bookmark.id}
      indicator={
        bookmark.pinned ? (
          <span className="text-muted-foreground" role="img" aria-label={t("bookmarks.list.pinned")}>
            <PinIcon aria-hidden="true" className="size-4" />
          </span>
        ) : null
      }
      host={bookmark.host}
      onOpen={() => {
        recordOpen(router.options.context.api, bookmark.id);
      }}
      onSelectedChange={(next) => {
        onSelectedChange(bookmark, next);
      }}
      selected={selected}
      selectionActive={selectionActive}
      selectLabel={t("bookmarks.list.select", { title: bookmark.title })}
      tabStop={tabStop}
      subtitle={bookmark.host}
      title={bookmark.title}
    >
      {bookmark.folders.length === 0 && bookmark.tags.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <FolderDots folders={bookmark.folders} />
          <TagBadges tags={bookmark.tags} />
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        {bookmark.slug === null ? (
          <span className="text-muted-foreground">{t("bookmarks.list.noSlug")}</span>
        ) : (
          <span className="font-mono text-foreground" translate="no">
            {`/go/${bookmark.slug}`}
          </span>
        )}
        <span className="text-muted-foreground">{usage}</span>
      </div>
    </CardGridItem>
  );
}
