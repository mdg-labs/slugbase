import { feedbackToast } from "@slugbase/ui/patterns";
import { toastManager } from "@slugbase/ui";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { patchLists } from "../bookmarks/bookmark-list-actions.ts";
import { BOOKMARK_LISTS_QUERY_KEY, BOOKMARKS_QUERY_KEY, bookmarkFailureOf, updateBookmark, type Bookmark } from "../bookmarks/bookmarks.ts";
import { GO_PREFERENCES_QUERY_KEY, deleteGoPreference, forwardingFailureOf, type GoPreference } from "./forwarding.ts";

const FORWARDING_MUTATION_KEY = ["bookmarks", "forwarding"] as const;
const REMOVE_MUTATION_KEY = ["go-preferences", "remove"] as const;

interface ForwardingRequest {
  readonly bookmark: Bookmark;
  readonly forwarding: boolean;
}

/** The identifiers of the bookmarks whose forwarding is being saved. */
export function usePendingForwarding(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: FORWARDING_MUTATION_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as ForwardingRequest).bookmark.id,
  });
  return new Set(ids);
}

/**
 * Turns the forwarding of a bookmark on or off (doc 03 "Optimistic where safe"): the list shows the change at once, and puts
 * the bookmark back the way it was, with a toast, when the server refuses. The change is made against the version the list
 * holds, so a bookmark changed elsewhere is refused instead of overwritten; the list is read again afterwards either way.
 * Turning forwarding off also ends the remembered choices of the bookmark, so those are read again too.
 */
export function useSetForwarding(): { readonly setForwarding: (bookmark: Bookmark, forwarding: boolean) => void } {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const mutation = useMutation({
    mutationKey: FORWARDING_MUTATION_KEY,
    mutationFn: ({ bookmark, forwarding }: ForwardingRequest): Promise<Bookmark> => updateBookmark(api, bookmark.id, bookmark.version, { forwarding }),
    onMutate: async ({ bookmark, forwarding }) => {
      // A read that is on its way would bring back the old state over the change shown.
      await queryClient.cancelQueries({ queryKey: BOOKMARK_LISTS_QUERY_KEY });
      patchLists(queryClient, bookmark.id, (item) => ({ ...item, forwarding }));
    },
    onSuccess: (saved) => {
      patchLists(queryClient, saved.id, () => saved);
    },
    onError: (error, { bookmark, forwarding }) => {
      patchLists(queryClient, bookmark.id, (item) => ({ ...item, forwarding: bookmark.forwarding }));
      const failure = bookmarkFailureOf(error);
      // An ended session is answered by the app as a whole.
      if (failure !== undefined) {
        feedbackToast.error(
          failure.kind === "changedElsewhere"
            ? t("forwarding.slugs.error.changedElsewhere")
            : failure.kind === "notFound"
              ? t("forwarding.slugs.error.notFound")
              : forwarding
                ? t("forwarding.slugs.error.turnOn")
                : t("forwarding.slugs.error.turnOff"),
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: GO_PREFERENCES_QUERY_KEY });
    },
  });
  return {
    setForwarding: (bookmark, forwarding) => {
      mutation.mutate({ bookmark, forwarding });
    },
  };
}

interface PendingRemoval {
  readonly choice: GoPreference;
  readonly toastId: string;
  settled: boolean;
}

/**
 * Removes a remembered choice (doc 03 section 8): the row goes at once, without a confirmation, and the toast that says so
 * offers an undo. The server is asked to forget the choice only when the toast closes without the undo, or when the page is
 * left or hidden first, so an undo restores the row without any request: the only operation that stores a choice
 * (`POST /go/choose`) also counts a use of the bookmark. `hidden` holds the slugs whose row is not shown.
 */
export function useRemoveGoPreference(): { readonly remove: (choice: GoPreference) => void; readonly hidden: ReadonlySet<string> } {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Map<string, PendingRemoval>());
  const show = useCallback((slug: string): void => {
    setHidden((current) => {
      const next = new Set(current);
      next.delete(slug);
      return next;
    });
  }, []);
  const mutation = useMutation({
    mutationKey: REMOVE_MUTATION_KEY,
    mutationFn: ({ slug }: GoPreference): Promise<void> => deleteGoPreference(api, slug),
    onError: (error, { slug }) => {
      show(slug);
      const failure = forwardingFailureOf(error);
      // An ended session is answered by the app as a whole.
      if (failure !== undefined) {
        feedbackToast.error(failure.kind === "notFound" ? t("forwarding.choices.error.notFound") : t("forwarding.choices.error.remove"));
      }
    },
    onSettled: async (_result, _error, { slug }) => {
      await queryClient.invalidateQueries({ queryKey: GO_PREFERENCES_QUERY_KEY });
      show(slug);
    },
  });
  const { mutate } = mutation;
  /** Sends the removal of a choice the member did not take back; a removal is sent once. */
  const settle = useCallback(
    (entry: PendingRemoval): void => {
      if (entry.settled) {
        return;
      }
      entry.settled = true;
      if (pending.current.get(entry.choice.slug) === entry) {
        pending.current.delete(entry.choice.slug);
      }
      mutate(entry.choice);
    },
    [mutate],
  );
  const flush = useCallback((): void => {
    for (const entry of [...pending.current.values()]) {
      toastManager.close(entry.toastId);
      settle(entry);
    }
  }, [settle]);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  return {
    hidden,
    remove: (choice) => {
      if (pending.current.has(choice.slug)) {
        return;
      }
      setHidden((current) => new Set(current).add(choice.slug));
      const entry: PendingRemoval = {
        choice,
        settled: false,
        toastId: toastManager.add({
          type: "success",
          title: t("forwarding.choices.removed", { slug: choice.slug }),
          actionProps: {
            children: t("forwarding.choices.undo"),
            onClick: () => {
              if (entry.settled) {
                return;
              }
              entry.settled = true;
              pending.current.delete(choice.slug);
              show(choice.slug);
              toastManager.close(entry.toastId);
              feedbackToast.success(t("forwarding.choices.restored", { slug: choice.slug }));
            },
          },
          onClose: () => {
            settle(entry);
          },
        }),
      };
      pending.current.set(choice.slug, entry);
    },
  };
}
