import { useMutation, useMutationState, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { feedbackToast } from "@slugbase/ui/patterns";
import { useTranslation } from "react-i18next";
import {
  BOOKMARK_LISTS_QUERY_KEY,
  BOOKMARKS_QUERY_KEY,
  bookmarkFailureOf,
  deleteBookmark,
  updateBookmark,
  type Bookmark,
  type BookmarkPage,
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
