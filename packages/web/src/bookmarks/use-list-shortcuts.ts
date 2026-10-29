import { useShortcut } from "@slugbase/ui";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState, type FocusEvent, type RefObject } from "react";
import { focusedItem, type BookmarkSelection } from "./bookmark-selection.ts";
import { isHttpUrl, isSharedWithMe, recordOpen, type Bookmark } from "./bookmarks.ts";
import type { BookmarkListControls, BookmarkView } from "./list-search.ts";
import type { BookmarkModalControls } from "./modal-search.ts";

export interface ListShortcutsInput {
  /** The bookmarks on screen, in order. */
  readonly items: readonly Bookmark[];
  readonly view: BookmarkView;
  readonly selection: BookmarkSelection;
  /** Whether any filter narrows the list. */
  readonly filtered: boolean;
  readonly controls: BookmarkListControls;
  readonly modal: BookmarkModalControls;
  readonly pin: (bookmark: Bookmark, pinned: boolean) => void;
  /** The bookmarks whose pin is being saved; a second change waits for the first. */
  readonly pendingPins: ReadonlySet<string>;
}

/** What the list needs to be moved through: the element that holds the items, and the item that is the stop on the Tab key. */
export interface ListNavigation {
  readonly ref: RefObject<HTMLDivElement | null>;
  /** Notes which item focus is in, so the Tab key comes back to it. */
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
  /** The item the Tab key reaches (roving tabindex, doc 03 section 15): the one focus was last in, the first until then. */
  readonly tabStopId: string | undefined;
}

/**
 * The keyboard shortcuts of the list (doc 03 section 14), all of them single-key shortcuts: `J` and `K` or the arrow keys
 * move focus from item to item, `Enter` follows the focused item, Ctrl or Command `Enter` opens it in a new tab, `E` edits
 * it, `P` pins or unpins it (both only a bookmark of the member's own), `V` switches between the grid and the table, and `Esc` clears the selection and, with none,
 * the filters. An open overlay takes `Esc` for itself before this does. The returned `ListNavigation` is for the element
 * that holds the items.
 */
export function useListShortcuts({ items, view, selection, filtered, controls, modal, pin, pendingPins }: ListShortcutsInput): ListNavigation {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [lastFocused, setLastFocused] = useState<string | undefined>(undefined);
  const tabStopId = items.some((bookmark) => bookmark.id === lastFocused) ? lastFocused : items[0]?.id;

  const focusedBookmark = (): Bookmark | undefined => {
    const id = focusedItem()?.dataset.itemId;
    return items.find((bookmark) => bookmark.id === id);
  };
  // Enter and Ctrl Enter belong to whatever inside an item has focus; they act only on the item itself.
  const itemWithFocus = (): HTMLElement | null => {
    const item = focusedItem();
    return item !== null && item === document.activeElement ? item : null;
  };

  const move = (step: 1 | -1, event: KeyboardEvent, fromListOnly: boolean): void => {
    const list = ref.current;
    const active = document.activeElement;
    if (list === null || (fromListOnly && active !== null && active !== document.body && !list.contains(active))) {
      return;
    }
    const elements = Array.from(list.querySelectorAll<HTMLElement>("[data-item-id]"));
    const here = elements.findIndex((element) => element === focusedItem());
    const resume = elements.findIndex((element) => element.dataset.itemId === tabStopId);
    const next = here === -1 ? Math.max(resume, 0) : Math.min(Math.max(here + step, 0), elements.length - 1);
    const target = elements[next];
    if (target !== undefined) {
      event.preventDefault();
      target.focus();
    }
  };
  useShortcut({ key: "j" }, (event) => {
    move(1, event, false);
  });
  useShortcut({ key: "k" }, (event) => {
    move(-1, event, false);
  });
  // The arrow keys also belong to the controls around the list, so they move the list only from inside it or from the page.
  useShortcut({ key: "ArrowDown" }, (event) => {
    move(1, event, true);
  });
  useShortcut({ key: "ArrowUp" }, (event) => {
    move(-1, event, true);
  });

  useShortcut({ key: "Enter" }, (event) => {
    const link = itemWithFocus()?.querySelector<HTMLAnchorElement>("a[href]");
    if (link !== null && link !== undefined) {
      event.preventDefault();
      link.click();
    }
  });
  useShortcut({ key: "Enter", mod: true }, (event) => {
    const id = itemWithFocus()?.dataset.itemId;
    const bookmark = items.find((candidate) => candidate.id === id);
    if (bookmark !== undefined && isHttpUrl(bookmark.url)) {
      event.preventDefault();
      recordOpen(router.options.context.api, bookmark.id);
      window.open(bookmark.url, "_blank", "noopener,noreferrer");
    }
  });
  useShortcut({ key: "e" }, () => {
    const bookmark = focusedBookmark();
    // A bookmark shared with the member is read-only (Q22), so neither the edit nor the pin shortcut reaches it.
    if (bookmark !== undefined && !isSharedWithMe(bookmark)) {
      modal.edit(bookmark.id);
    }
  });
  useShortcut({ key: "p" }, () => {
    const bookmark = focusedBookmark();
    if (bookmark !== undefined && !isSharedWithMe(bookmark) && !pendingPins.has(bookmark.id)) {
      pin(bookmark, !bookmark.pinned);
    }
  });
  useShortcut({ key: "v" }, () => {
    controls.update({ view: view === "grid" ? "table" : "grid" });
  });
  useShortcut({ key: "Escape" }, (event) => {
    if (selection.ids.size > 0) {
      event.preventDefault();
      selection.clear();
    } else if (filtered) {
      event.preventDefault();
      controls.clearFilters();
    }
  });

  return {
    ref,
    onFocus: (event) => {
      const id = event.target.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
      if (id !== undefined) {
        setLastFocused(id);
      }
    },
    tabStopId,
  };
}
