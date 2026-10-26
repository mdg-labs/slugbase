import { BulkBar, BulkBarButton, Confirm, type BulkBarAction, FolderIcon, PinIcon, PinOffIcon, TagIcon, Trash2Icon, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import type { BulkBookmarks } from "./bookmark-list-actions.ts";
import type { BookmarkSelection } from "./bookmark-selection.ts";
import { BOOKMARK_SELECT_ALL_CAP, bookmarkFailureOf, listBookmarkIds } from "./bookmarks.ts";
import { BulkLinkOverlay, type LinkAction } from "./bulk-link-overlay.tsx";
import type { BookmarkFilterParams } from "./list-search.ts";

interface SelectAllRequest {
  readonly filters: BookmarkFilterParams;
  readonly scope: string;
}

export interface BookmarksBulkBarProps {
  readonly selection: BookmarkSelection;
  readonly bulk: BulkBookmarks;
  /** The filters of the list on screen, the folder and the tags included, which "select all matching" names. */
  readonly filters: BookmarkFilterParams;
  /** How many bookmarks match the filters; null when more than the API counts. */
  readonly total: number | null;
}

/**
 * The bar of the bookmark list's selection (doc 03 section 3.4): the count, "Select all matching", and add to a folder,
 * remove from a folder, add tags, remove tags, pin, unpin and delete for the selected bookmarks. The folder and tag actions
 * first ask which folder or tags, over the bookmarks selected when the picker was opened. Select all asks the API for the identifiers the filters match, at most the
 * select-all cap, and says so when more match. Delete first states how many bookmarks it removes and what happens to
 * their slugs.
 */
export function BookmarksBulkBar({ selection, bulk, filters, total }: BookmarksBulkBarProps): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const [capped, setCapped] = useState(false);
  // The bookmarks the delete confirmation was opened on, so the count it states is the count it deletes.
  const [deleting, setDeleting] = useState<readonly string[] | undefined>(undefined);
  // The same for the folder and tag pickers.
  const [linking, setLinking] = useState<{ readonly action: LinkAction; readonly ids: readonly string[] } | undefined>(undefined);
  const selectAll = useMutation({
    mutationKey: ["bookmarks", "select-all"],
    // The request names the filters and the scope it was made under, which its answer is kept to.
    mutationFn: ({ filters: asked }: SelectAllRequest) => listBookmarkIds(router.options.context.api, asked),
    onSuccess: ({ ids, truncated }, { scope }) => {
      if (scope === selection.scope) {
        selection.replace(ids, scope);
        setCapped(truncated);
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
  const cap = format.number(BOOKMARK_SELECT_ALL_CAP);
  const busy = bulk.running !== undefined || bulk.undoing || selectAll.isPending;
  const ids = [...selection.ids];

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
  const actions: readonly BulkBarAction[] = [
    linkAction("add_to_folder", t("bookmarks.bulk.addToFolder"), <FolderIcon aria-hidden="true" />),
    linkAction("remove_from_folder", t("bookmarks.bulk.removeFromFolder"), <FolderIcon aria-hidden="true" />),
    linkAction("add_tags", t("bookmarks.bulk.addTags"), <TagIcon aria-hidden="true" />),
    linkAction("remove_tags", t("bookmarks.bulk.removeTags"), <TagIcon aria-hidden="true" />),
    { id: "pin", label: t("bookmarks.bulk.pin"), icon: <PinIcon aria-hidden="true" />, loading: bulk.running === "pin", onSelect: () => { bulk.run("pin", ids); } },
    { id: "unpin", label: t("bookmarks.bulk.unpin"), icon: <PinOffIcon aria-hidden="true" />, loading: bulk.running === "unpin", onSelect: () => { bulk.run("unpin", ids); } },
    { id: "delete", label: t("bookmarks.bulk.delete.action"), icon: <Trash2Icon aria-hidden="true" />, destructive: true, loading: bulk.running === "delete", onSelect: () => { setDeleting(ids); } },
  ];
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
