import { Button, Tooltip, TooltipPopup, TooltipTrigger } from "@slugbase/ui";
import { BulkBar, BulkBarButton, Confirm, type BulkBarAction, ExternalLinkIcon, FolderIcon, PinIcon, PinOffIcon, Share2Icon, TagIcon, Trash2Icon, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { useSharingGranted } from "../sharing/index.ts";
import type { BulkBookmarks } from "./bookmark-list-actions.ts";
import type { BookmarkSelection } from "./bookmark-selection.ts";
import { openInNewTab } from "./bookmark-open.ts";
import { BOOKMARK_SELECT_ALL_CAP, bookmarkFailureOf, isSharedWithMe, listBookmarkIds, type Bookmark, type BulkShareTarget } from "./bookmarks.ts";
import { BulkLinkOverlay, type LinkAction } from "./bulk-link-overlay.tsx";
import { BulkShareOverlay } from "./bulk-share-overlay.tsx";
import type { BookmarkFilterParams } from "./list-search.ts";

interface SelectAllRequest {
  readonly filters: BookmarkFilterParams;
  readonly scope: string;
}

/** The identifiers a select-all found that are shared with the member, which belong to the selection it was made under. */
interface SharedFound {
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
}

const NO_SHARED: ReadonlySet<string> = new Set();

/** A bulk action the selection limits, shown as disabled with the reason on hover and on focus. */
function LimitedAction({ action, reason }: { readonly action: BulkBarAction; readonly reason: string }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
        <Button className="pointer-events-none" disabled size="sm" variant={action.destructive === true ? "destructive-outline" : "outline"}>
          {action.icon}
          {action.label}
        </Button>
      </TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

export interface BookmarksBulkBarProps {
  readonly selection: BookmarkSelection;
  readonly bulk: BulkBookmarks;
  /** The filters of the list on screen, the folder and the tags included, which "select all matching" names. */
  readonly filters: BookmarkFilterParams;
  /** How many bookmarks match the filters; null when more than the API counts. */
  readonly total: number | null;
  /** The bookmarks loaded in the list, which tell the selection what it holds and which "Open all" opens. */
  readonly items: readonly Bookmark[];
}

/**
 * The bar of the bookmark list's selection (doc 03 section 3.4): the count, "Select all matching", and add to a folder,
 * remove from a folder, add tags, remove tags, share, pin, unpin and delete for the selected bookmarks. The folder and tag actions
 * first ask which folder or tags, and a share which member or team with the preview of it, over the bookmarks selected when the
 * picker was opened. Share is offered where the workspace may share. Select all asks the API for the identifiers the filters match, at most the
 * select-all cap, and says so when more match. Delete first states how many bookmarks it removes and what happens to
 * their slugs. Bookmarks shared with the member can only be opened (doc 02 section 8.2, Q22): where the selection holds one,
 * the actions that change bookmarks stay in the bar disabled, each saying why, and the bar says that only "Open all" is left.
 */
export function BookmarksBulkBar({ selection, bulk, filters, total, items }: BookmarksBulkBarProps): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const [capped, setCapped] = useState(false);
  // The bookmarks the delete confirmation was opened on, so the count it states is the count it deletes.
  const [deleting, setDeleting] = useState<readonly string[] | undefined>(undefined);
  // The same for the folder and tag pickers.
  const [linking, setLinking] = useState<{ readonly action: LinkAction; readonly ids: readonly string[] } | undefined>(undefined);
  const [sharing, setSharing] = useState<readonly string[] | undefined>(undefined);
  const sharingGranted = useSharingGranted();
  const [sharedFound, setSharedFound] = useState<SharedFound | undefined>(undefined);
  const selectAll = useMutation({
    mutationKey: ["bookmarks", "select-all"],
    // The request names the filters and the scope it was made under, which its answer is kept to.
    mutationFn: async ({ filters: asked }: SelectAllRequest) => {
      const api = router.options.context.api;
      // Which of the matching bookmarks are shared with the member is not in the loaded list when more match than are loaded, so
      // the shared ones are asked for as well, with the same filters. A folder, a tag or a pin names the member's own things, so with
      // one of them no shared bookmark matches (doc 04 section 6.1); and a list of one scope needs no second answer.
      const ownThings = asked.folderId !== undefined || asked.pinned !== undefined || (asked.tag?.length ?? 0) > 0;
      const [found, shared] = await Promise.all([listBookmarkIds(api, asked), asked.scope === undefined && !ownThings ? listBookmarkIds(api, { ...asked, scope: "shared_with_me" }) : undefined]);
      return { ...found, shared: shared?.ids ?? [] };
    },
    onSuccess: ({ ids, truncated, shared }, { scope }) => {
      if (scope === selection.scope) {
        selection.replace(ids, scope);
        setCapped(truncated);
        setSharedFound({ scope, ids: new Set(shared) });
      }
    },
    onError: (error) => {
      // An ended session is answered by the app as a whole.
      if (bookmarkFailureOf(error) !== undefined) {
        feedbackToast.error(t("bookmarks.bulk.selectAll.error"));
      }
    },
  });
  const size = selection.ids.size;
  if (size === 0 && capped) {
    // The note belongs to the selection that was capped; a new selection starts without it.
    setCapped(false);
  }
  if (size === 0 && sharedFound !== undefined) {
    setSharedFound(undefined);
  }
  const cap = format.number(BOOKMARK_SELECT_ALL_CAP);
  const busy = bulk.running !== undefined || bulk.undoing || selectAll.isPending;
  const ids = [...selection.ids];
  // A selection holds a shared bookmark when the list is the shared-with-me one, or a loaded bookmark of it is shared, or the select-all found it shared.
  const loadedShared = new Set(items.filter(isSharedWithMe).map((bookmark) => bookmark.id));
  const foundShared = sharedFound?.scope === selection.scope ? sharedFound.ids : NO_SHARED;
  const sharedCount = ids.filter((id) => filters.scope === "shared_with_me" || loadedShared.has(id) || foundShared.has(id)).length;
  const limited = sharedCount > 0;
  const openAll = (): void => {
    const loaded = new Map(items.map((bookmark) => [bookmark.id, bookmark]));
    let opened = 0;
    for (const id of ids) {
      const bookmark = loaded.get(id);
      if (bookmark !== undefined && openInNewTab(router.options.context.api, bookmark)) {
        opened += 1;
      }
    }
    if (opened < ids.length) {
      feedbackToast.info(t("bookmarks.bulk.openAll.partial", { opened, selected: ids.length }));
    }
  };

  let selectAllLabel: string;
  if (total === null) {
    selectAllLabel = t("bookmarks.bulk.selectAll.capped", { cap });
  } else if (total > BOOKMARK_SELECT_ALL_CAP) {
    selectAllLabel = t("bookmarks.bulk.selectAll.cappedOf", { cap, total: format.number(total) });
  } else {
    selectAllLabel = t("bookmarks.bulk.selectAll.all", { total: format.number(total) });
  }
  const offerSelectAll = !capped && (total === null || total > size);

  const linkAction = (action: LinkAction, label: string, icon: ReactElement): BulkBarAction => ({
    id: action,
    label,
    icon,
    loading: bulk.running === action,
    onSelect: () => {
      setLinking({ action, ids });
    },
  });
  const ownOnlyActions: readonly BulkBarAction[] = [
    linkAction("add_to_folder", t("bookmarks.bulk.addToFolder"), <FolderIcon aria-hidden="true" />),
    linkAction("remove_from_folder", t("bookmarks.bulk.removeFromFolder"), <FolderIcon aria-hidden="true" />),
    linkAction("add_tags", t("bookmarks.bulk.addTags"), <TagIcon aria-hidden="true" />),
    linkAction("remove_tags", t("bookmarks.bulk.removeTags"), <TagIcon aria-hidden="true" />),
    ...(sharingGranted
      ? [
          {
            id: "share",
            label: t("bookmarks.bulk.share.action"),
            icon: <Share2Icon aria-hidden="true" />,
            loading: bulk.running === "share",
            onSelect: () => {
              setSharing(ids);
            },
          },
        ]
      : []),
    { id: "pin", label: t("bookmarks.bulk.pin"), icon: <PinIcon aria-hidden="true" />, loading: bulk.running === "pin", onSelect: () => { bulk.run("pin", ids); } },
    { id: "unpin", label: t("bookmarks.bulk.unpin"), icon: <PinOffIcon aria-hidden="true" />, loading: bulk.running === "unpin", onSelect: () => { bulk.run("unpin", ids); } },
    { id: "delete", label: t("bookmarks.bulk.delete.action"), icon: <Trash2Icon aria-hidden="true" />, destructive: true, loading: bulk.running === "delete", onSelect: () => { setDeleting(ids); } },
  ];
  const openAllAction: BulkBarAction = { id: "openAll", label: t("bookmarks.bulk.openAll.action"), icon: <ExternalLinkIcon aria-hidden="true" />, onSelect: openAll };
  const actions: readonly BulkBarAction[] = limited ? [openAllAction] : [openAllAction, ...ownOnlyActions];
  const confirmDelete = (): void => {
    if (deleting !== undefined) {
      bulk.run("delete", deleting, {
        onSettled: () => {
          setDeleting(undefined);
        },
      });
    }
  };
  const deletingCount = deleting?.length ?? 0;
  const shareWith = (named: readonly string[], target: BulkShareTarget): void => {
    bulk.run("share", named, { target: { shareWith: target } });
    setSharing(undefined);
  };

  return (
    <>
      {size === 0 ? null : (
        <BulkBar
          actions={actions}
          busy={busy}
          clear={{ label: t("bookmarks.bulk.clear"), onClear: selection.clear }}
          count={t("bookmarks.bulk.count", { count: size })}
          label={t("bookmarks.bulk.label")}
        >
          {offerSelectAll ? (
            <BulkBarButton
              disabled={bulk.running !== undefined || bulk.undoing}
              loading={selectAll.isPending}
              onClick={() => {
                selectAll.mutate({ filters, scope: selection.scope });
              }}
            >
              {selectAllLabel}
            </BulkBarButton>
          ) : null}
          {capped ? <span className="text-muted-foreground text-sm">{t("bookmarks.bulk.selectAll.cappedNote", { cap })}</span> : null}
          {limited ? (
            <>
              <span className="text-muted-foreground text-sm">{t("bookmarks.bulk.limited.note", { count: sharedCount })}</span>
              {ownOnlyActions.map((action) => (
                <LimitedAction action={action} key={action.id} reason={t("bookmarks.bulk.limited.reason")} />
              ))}
            </>
          ) : null}
        </BulkBar>
      )}
      {linking === undefined ? null : (
        <BulkLinkOverlay
          action={linking.action}
          ids={linking.ids}
          onClose={() => {
            setLinking(undefined);
          }}
          onSubmit={(target) => {
            bulk.run(linking.action, linking.ids, { target });
            setLinking(undefined);
          }}
        />
      )}
      {sharing === undefined ? null : (
        <BulkShareOverlay
          ids={sharing}
          onClose={() => {
            setSharing(undefined);
          }}
          onSubmit={(target) => {
            shareWith(sharing, target);
          }}
        />
      )}
      <Confirm
        cancelLabel={t("bookmarks.bulk.delete.cancel")}
        confirmLabel={t("bookmarks.bulk.delete.confirm", { count: deletingCount })}
        description={t("bookmarks.bulk.delete.description", { count: deletingCount })}
        destructive
        loading={bulk.running === "delete"}
        onConfirm={confirmDelete}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined);
          }
        }}
        open={deleting !== undefined}
        title={t("bookmarks.bulk.delete.title", { count: deletingCount })}
      />
    </>
  );
}
