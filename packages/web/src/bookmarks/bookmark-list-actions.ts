import { useMutation, useMutationState, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toastManager } from "@slugbase/ui";
import { feedbackToast } from "@slugbase/ui/patterns";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient } from "../api/client.ts";
import { FOLDERS_QUERY_KEY } from "../folders/folders.ts";
import { TAGS_QUERY_KEY } from "../tags/tags.ts";
import type { BookmarkSelection } from "./bookmark-selection.ts";
import {
  BOOKMARK_LISTS_QUERY_KEY,
  BOOKMARKS_QUERY_KEY,
  BulkPartialError,
  bookmarkFailureOf,
  bulkBookmarks,
  deleteBookmark,
  listBookmarkIds,
  updateBookmark,
  type Bookmark,
  type BookmarkFolder,
  type BookmarkPage,
  type BulkAction,
  type BulkTarget,
  type BulkTotals,
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

/** The bulk actions the bar offers. */
export type BulkRunAction = Exclude<BulkAction, "move_to_folder">;

interface BulkRequest {
  readonly action: BulkRunAction;
  readonly ids: readonly string[];
  /** The folder or tags of a folder or tag action. */
  readonly target?: BulkTarget;
  /** The selection's scope when the request was made, which its answer changes the selection of and no other. */
  readonly scope: string;
}

interface UndoRequest {
  readonly folder: BookmarkFolder;
  readonly ids: readonly string[];
}

type Links = Pick<Bookmark, "folders" | "tags">;

interface BulkContext {
  /** The folders and tags the bookmarks of the request had before the list showed the change. */
  readonly before: ReadonlyMap<string, Links>;
  /** The bookmarks a removal took out of the folder, which an undo puts back; undefined when that is not known. */
  readonly undoIds: readonly string[] | undefined;
}

export interface BulkRunOptions {
  /** The folder or tags of a folder or tag action. */
  readonly target?: BulkTarget;
  /** Called when the request has settled, whatever it came to. */
  readonly onSettled?: () => void;
}

export interface BulkBookmarks {
  /** Runs the action on the bookmarks `ids`; the selection is cleared when it is done and keeps what was not reached when it fails. */
  readonly run: (action: BulkRunAction, ids: readonly string[], options?: BulkRunOptions) => void;
  /** The action that is running, if one is. */
  readonly running: BulkRunAction | undefined;
  /** Whether an undo is running. */
  readonly undoing: boolean;
  /** What the last request came to, as a sentence for a live region; empty while one runs. */
  readonly announcement: string;
}

function byName<Item extends { readonly name: string }>(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

/** The bookmark as the list shows it once the folder or tag action is done. */
function relinked(bookmark: Bookmark, action: BulkRunAction, target: BulkTarget): Bookmark {
  if ("folder" in target) {
    const { folder } = target;
    if (action === "add_to_folder") {
      return bookmark.folders.some(({ id }) => id === folder.id) ? bookmark : { ...bookmark, folders: byName([...bookmark.folders, folder]) };
    }
    return action === "remove_from_folder" ? { ...bookmark, folders: bookmark.folders.filter(({ id }) => id !== folder.id) } : bookmark;
  }
  const chosen = new Set(target.tags.map(({ id }) => id));
  if (action === "add_tags") {
    return { ...bookmark, tags: byName([...bookmark.tags, ...target.tags.filter(({ id }) => !bookmark.tags.some((tag) => tag.id === id))]) };
  }
  return action === "remove_tags" ? { ...bookmark, tags: bookmark.tags.filter(({ id }) => !chosen.has(id)) } : bookmark;
}

/** Changes the bookmarks `ids` wherever a loaded list holds them. */
function patchMany(queryClient: QueryClient, ids: ReadonlySet<string>, change: (bookmark: Bookmark) => Bookmark): void {
  queryClient.setQueriesData<InfiniteData<BookmarkPage>>({ queryKey: BOOKMARK_LISTS_QUERY_KEY }, (data) =>
    data === undefined
      ? data
      : { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (ids.has(item.id) ? change(item) : item)) })) },
  );
}

/** The folders and tags that the loaded lists show on the bookmarks `ids`. */
function linksOf(queryClient: QueryClient, ids: ReadonlySet<string>): Map<string, Links> {
  const links = new Map<string, Links>();
  for (const [, data] of queryClient.getQueriesData<InfiniteData<BookmarkPage>>({ queryKey: BOOKMARK_LISTS_QUERY_KEY })) {
    for (const item of data?.pages.flatMap((page) => page.items) ?? []) {
      if (ids.has(item.id) && !links.has(item.id)) {
        links.set(item.id, { folders: item.folders, tags: item.tags });
      }
    }
  }
  return links;
}

/**
 * Which of the bookmarks `ids` are in the folder now, from the API. Undefined when that cannot be told (the folder holds
 * more bookmarks than one answer lists, or the request failed): the removal is then done without an undo, which is the
 * only thing the answer is used for.
 */
async function membersOf(api: ApiClient, folderId: string, ids: readonly string[]): Promise<readonly string[] | undefined> {
  try {
    const { ids: members, truncated } = await listBookmarkIds(api, { folderId });
    if (truncated) {
      return undefined;
    }
    const inFolder = new Set(members);
    return ids.filter((id) => inFolder.has(id));
  } catch {
    return undefined;
  }
}

function doneTitle(t: TFunction, action: BulkRunAction, count: number, target: BulkTarget | undefined): string {
  const folder = target !== undefined && "folder" in target ? target.folder.name : "";
  switch (action) {
    case "delete":
      return t("bookmarks.bulk.done.delete", { count });
    case "pin":
      return t("bookmarks.bulk.done.pin", { count });
    case "unpin":
      return t("bookmarks.bulk.done.unpin", { count });
    case "add_to_folder":
      return t("bookmarks.bulk.done.addToFolder", { count, folder });
    case "remove_from_folder":
      return t("bookmarks.bulk.done.removeFromFolder", { count, folder });
    case "add_tags":
      return t("bookmarks.bulk.done.addTags", { count });
    case "remove_tags":
      return t("bookmarks.bulk.done.removeTags", { count });
  }
}

function failureTitle(t: TFunction, action: BulkRunAction): string {
  switch (action) {
    case "delete":
      return t("bookmarks.bulk.error.delete");
    case "pin":
      return t("bookmarks.bulk.error.pin");
    case "unpin":
      return t("bookmarks.bulk.error.unpin");
    case "add_to_folder":
      return t("bookmarks.bulk.error.addToFolder");
    case "remove_from_folder":
      return t("bookmarks.bulk.error.removeFromFolder");
    case "add_tags":
      return t("bookmarks.bulk.error.addTags");
    case "remove_tags":
      return t("bookmarks.bulk.error.removeTags");
  }
}

/**
 * Says what a request came to in a toast, with the skipped count beside the done count, and returns the sentence for the
 * live region. `undo` adds a button to the toast.
 */
function raiseResult(t: TFunction, title: string, skipped: number, undo?: { readonly label: string; readonly onClick: () => void }): string {
  const detail = skipped === 0 ? undefined : t("bookmarks.bulk.skipped", { count: skipped });
  toastManager.add({
    type: detail === undefined ? "success" : "info",
    title,
    description: detail,
    ...(undo === undefined ? {} : { actionProps: { children: undo.label, onClick: undo.onClick } }),
  });
  return detail === undefined ? title : `${title} ${detail}`;
}

/**
 * The bulk actions on the selection (doc 03 section 3.4). The result is said in a toast and in `announcement`, which the
 * page keeps in a live region that outlives the bar: the counts of those affected and those skipped. A folder or tag
 * action shows its change in the loaded lists at once and puts the lists back the way they were when it fails. A removal
 * from a folder offers an undo in the toast, which files the bookmarks it took out of the folder in it again. A failure
 * changes no bookmark of the request that failed and keeps the selection, so the member can try again.
 */
export function useBulkBookmarks(selection: BookmarkSelection): BulkBookmarks {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [announcement, setAnnouncement] = useState("");
  const undo = useMutation({
    mutationKey: ["bookmarks", "bulk", "undo"],
    mutationFn: ({ folder, ids }: UndoRequest) => bulkBookmarks(api, "add_to_folder", ids, { folder }),
    onSuccess: ({ affected, skipped }, { folder }) => {
      setAnnouncement(raiseResult(t, t("bookmarks.bulk.done.undone", { count: affected, folder: folder.name }), skipped));
    },
    onError: (error) => {
      // An ended session is answered by the app as a whole.
      if (bookmarkFailureOf(error) !== undefined) {
        const message = t("bookmarks.bulk.error.undo");
        feedbackToast.error(message);
        setAnnouncement(message);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
    },
  });

  const mutation = useMutation<BulkTotals, Error, BulkRequest, BulkContext | undefined>({
    mutationKey: ["bookmarks", "bulk"],
    mutationFn: ({ action, ids, target }) => bulkBookmarks(api, action, ids, target),
    onMutate: async ({ action, ids, target }) => {
      setAnnouncement("");
      if (target === undefined) {
        return undefined;
      }
      // A read that is on its way would bring back the old links over the change shown.
      await queryClient.cancelQueries({ queryKey: BOOKMARK_LISTS_QUERY_KEY });
      const requested = new Set(ids);
      const before = linksOf(queryClient, requested);
      patchMany(queryClient, requested, (bookmark) => relinked(bookmark, action, target));
      const undoIds = action === "remove_from_folder" && "folder" in target ? await membersOf(api, target.folder.id, ids) : undefined;
      return { before, undoIds };
    },
    onSuccess: ({ affected, skipped }, { action, scope, target }, context) => {
      const undoIds = context?.undoIds;
      const undoing =
        action === "remove_from_folder" && target !== undefined && "folder" in target && affected > 0 && undoIds !== undefined && undoIds.length > 0
          ? { folder: target.folder, ids: undoIds }
          : undefined;
      setAnnouncement(
        raiseResult(
          t,
          doneTitle(t, action, affected, target),
          skipped,
          undoing === undefined
            ? undefined
            : {
                label: t("bookmarks.bulk.undo"),
                onClick: () => {
                  undo.mutate(undoing);
                },
              },
        ),
      );
      selection.replace([], scope);
    },
    onError: (error, { action, ids, scope, target }, context) => {
      const partial = error instanceof BulkPartialError;
      if (context !== undefined) {
        // The turns before a failed one are done; only the bookmarks the request did not reach are put back.
        const unreached = new Set(partial ? error.remaining : ids);
        patchMany(queryClient, unreached, (bookmark) => ({ ...bookmark, ...context.before.get(bookmark.id) }));
      }
      const failure = bookmarkFailureOf(error);
      let message: string | undefined;
      if (partial) {
        selection.replace(error.remaining, scope);
        message = t("bookmarks.bulk.error.partial", { done: error.completed.affected, total: ids.length });
      } else if (failure?.kind === "notFound" && target !== undefined) {
        // The folder or a tag was deleted since the list of them was read.
        void queryClient.invalidateQueries({ queryKey: "folder" in target ? FOLDERS_QUERY_KEY : TAGS_QUERY_KEY });
        message = "folder" in target ? t("bookmarks.bulk.error.folderGone") : t("bookmarks.bulk.error.tagsGone");
      } else if (failure !== undefined) {
        message = failureTitle(t, action);
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
    run: (action, ids, options) => {
      mutation.mutate(
        { action, ids, scope: selection.scope, ...(options?.target === undefined ? {} : { target: options.target }) },
        options?.onSettled === undefined ? undefined : { onSettled: options.onSettled },
      );
    },
    running: mutation.isPending ? mutation.variables.action : undefined,
    undoing: undo.isPending,
    announcement,
  };
}
