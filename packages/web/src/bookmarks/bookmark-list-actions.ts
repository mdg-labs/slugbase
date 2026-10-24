import { useMutation, useMutationState, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { feedbackToast } from "@slugbase/ui/patterns";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BookmarkSelection } from "./bookmark-selection.ts";
import {
  BOOKMARK_LISTS_QUERY_KEY,
  BOOKMARKS_QUERY_KEY,
  BulkPartialError,
  bookmarkFailureOf,
  bulkBookmarks,
  deleteBookmark,
  updateBookmark,
  type Bookmark,
  type BookmarkPage,
  type BulkAction,
} from "./bookmarks.ts";

const PIN_MUTATION_KEY = ["bookmarks", "pin"] as const;

interface PinRequest {
  readonly bookmark: Bookmark;
  readonly pinned: boolean;
}

/** Changes the bookmark `id` wherever a loaded list holds it. */
function patchLists(queryClient: QueryClient, id: string, change: (bookmark: Bookmark) => Bookmark): void {
  queryClient.setQueriesData<InfiniteData<BookmarkPage>>({ queryKey: BOOKMARK_LISTS_QUERY_KEY }, (data) =>
    data === undefined
      ? data
      : { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === id ? change(item) : item)) })) },
  );
}

/** The identifiers of the bookmarks whose pin is being saved. */
export function usePendingPins(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: PIN_MUTATION_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as PinRequest).bookmark.id,
  });
  return new Set(ids);
}

/**
 * Pins or unpins a bookmark (doc 03 "Optimistic where safe"): the list shows the change at once, and puts the bookmark
 * back the way it was, with a toast, when the server refuses. The change is made against the version the list holds, so
 * a bookmark changed elsewhere is refused instead of overwritten; the list is read again afterwards either way.
 */
export function usePinBookmark(): { readonly pin: (bookmark: Bookmark, pinned: boolean) => void } {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const mutation = useMutation({
    mutationKey: PIN_MUTATION_KEY,
    mutationFn: ({ bookmark, pinned }: PinRequest): Promise<Bookmark> => updateBookmark(api, bookmark.id, bookmark.version, { pinned }),
    onMutate: async ({ bookmark, pinned }) => {
      // A read that is on its way would bring back the old pin over the change shown.
      await queryClient.cancelQueries({ queryKey: BOOKMARK_LISTS_QUERY_KEY });
      patchLists(queryClient, bookmark.id, (item) => ({ ...item, pinned }));
    },
    onSuccess: (saved) => {
      patchLists(queryClient, saved.id, () => saved);
    },
    onError: (error, { bookmark, pinned }) => {
      patchLists(queryClient, bookmark.id, (item) => ({ ...item, pinned: bookmark.pinned }));
      const failure = bookmarkFailureOf(error);
      // An ended session is answered by the app as a whole.
      if (failure !== undefined) {
        feedbackToast.error(
          failure.kind === "changedElsewhere"
            ? t("bookmarks.list.pin.error.changedElsewhere")
            : failure.kind === "notFound"
              ? t("bookmarks.list.pin.error.notFound")
              : pinned
                ? t("bookmarks.list.pin.error.pin")
                : t("bookmarks.list.pin.error.unpin"),
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
    },
  });
  return {
    pin: (bookmark, pinned) => {
      mutation.mutate({ bookmark, pinned });
    },
  };
}

/** Deletes a bookmark once the server has done it; the list does not show the bookmark gone before that. */
export function useDeleteBookmark(onDeleted: () => void): ReturnType<typeof useMutation<void, Error, string>> {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  return useMutation({
    mutationKey: ["bookmarks", "delete"],
    mutationFn: (id: string): Promise<void> => deleteBookmark(api, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      feedbackToast.success(t("bookmarks.list.deleted"));
      onDeleted();
    },
    onError: (error) => {
      // A bookmark that is gone already is gone from the list too once it is read again.
      if (bookmarkFailureOf(error)?.kind === "notFound") {
        void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      }
    },
  });
}

interface BulkRequest {
  readonly action: BulkAction;
  readonly ids: readonly string[];
  /** The selection's scope when the request was made, which its answer changes the selection of and no other. */
  readonly scope: string;
}

export interface BulkBookmarks {
  /** Deletes, pins or unpins the bookmarks `ids`; the selection is cleared when it is done and keeps what was not reached when it fails. */
  readonly run: (action: BulkAction, ids: readonly string[], onSettled?: () => void) => void;
  /** The action that is running, if one is. */
  readonly running: BulkAction | undefined;
  /** What the last request came to, as a sentence for a live region; empty while one runs. */
  readonly announcement: string;
}

/**
 * The bulk actions on the selection (doc 03 section 3.4). The result is said in a toast and in `announcement`, which the
 * page keeps in a live region that outlives the bar: the counts of those affected and those skipped. A failure changes no
 * bookmark of the request that failed and keeps the selection, so the member can try again.
 */
export function useBulkBookmarks(selection: BookmarkSelection): BulkBookmarks {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [announcement, setAnnouncement] = useState("");
  const mutation = useMutation({
    mutationKey: ["bookmarks", "bulk"],
    mutationFn: ({ action, ids }: BulkRequest) => bulkBookmarks(api, action, ids),
    onMutate: () => {
      setAnnouncement("");
    },
    onSuccess: ({ affected, skipped }, { action, scope }) => {
      const title =
        action === "delete"
          ? t("bookmarks.bulk.done.delete", { count: affected })
          : action === "pin"
            ? t("bookmarks.bulk.done.pin", { count: affected })
            : t("bookmarks.bulk.done.unpin", { count: affected });
      if (skipped === 0) {
        feedbackToast.success(title);
        setAnnouncement(title);
      } else {
        const detail = t("bookmarks.bulk.skipped", { count: skipped });
        feedbackToast.info(title, detail);
        setAnnouncement(`${title} ${detail}`);
      }
      selection.replace([], scope);
    },
    onError: (error, { action, ids, scope }) => {
      const partial = error instanceof BulkPartialError;
      let message: string | undefined;
      if (partial) {
        selection.replace(error.remaining, scope);
        message = t("bookmarks.bulk.error.partial", { done: error.completed.affected, total: ids.length });
      } else if (bookmarkFailureOf(error) !== undefined) {
        message = action === "delete" ? t("bookmarks.bulk.error.delete") : action === "pin" ? t("bookmarks.bulk.error.pin") : t("bookmarks.bulk.error.unpin");
      }
      // An ended session is answered by the app as a whole.
      if (message !== undefined) {
        feedbackToast.error(message);
        setAnnouncement(message);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
    },
  });
  return {
    run: (action, ids, onSettled) => {
      mutation.mutate({ action, ids, scope: selection.scope }, onSettled === undefined ? undefined : { onSettled });
    },
    running: mutation.isPending ? mutation.variables.action : undefined,
    announcement,
  };
}
