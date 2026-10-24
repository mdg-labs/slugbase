import { useShortcut } from "@slugbase/ui";
import { useState } from "react";

/** Which bookmarks are selected. The selection belongs to one set of filters and is empty once they change. */
export interface BookmarkSelection {
  /** The filters the selection belongs to; a request that answers later names it to change only its own selection. */
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
  readonly has: (id: string) => boolean;
  /** Selects or deselects one bookmark; without `selected` it flips. */
  readonly toggle: (id: string, selected?: boolean) => void;
  /** Adds bookmarks to the selection. */
  readonly add: (ids: readonly string[]) => void;
  /**
   * Makes `ids` the whole selection. With `scope`, the change is made only while the list is still under that scope, so
   * an answer to a request made under other filters never reaches the selection of the filters on screen.
   */
  readonly replace: (ids: readonly string[], scope?: string) => void;
  readonly clear: () => void;
}

interface Held {
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The selection of the bookmark list. `scope` names the filters the list is under: a selection made under other filters
 * is not shown and not acted on, so a bulk action never reaches a bookmark that the list on screen does not.
 */
export function useBookmarkSelection(scope: string): BookmarkSelection {
  const [held, setHeld] = useState<Held>({ scope, ids: NONE });
  const ids = held.scope === scope ? held.ids : NONE;
  const change = (next: (current: ReadonlySet<string>) => ReadonlySet<string>): void => {
    setHeld((previous) => ({ scope, ids: next(previous.scope === scope ? previous.ids : NONE) }));
  };
  return {
    scope,
    ids,
    has: (id) => ids.has(id),
    toggle: (id, selected) => {
      change((current) => {
        const next = new Set(current);
        if (selected ?? !current.has(id)) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    },
    add: (more) => {
      change((current) => new Set([...current, ...more]));
    },
    replace: (all, from = scope) => {
      if (from === scope) {
        change(() => new Set(all));
      }
    },
    clear: () => {
      change(() => NONE);
    },
  };
}

/** The list item that holds focus, if one does: the item itself or anything inside it. */
export function focusedItem(): HTMLElement | null {
  const item = document.activeElement?.closest("[data-item-id]");
  return item instanceof HTMLElement ? item : null;
}

/**
 * The selection shortcuts of doc 03 section 14, which are single-key shortcuts: `X` toggles the item that holds focus and
 * Shift `A` selects every bookmark loaded. Escape, which clears the selection first, is `useListShortcuts`'.
 */
export function useSelectionShortcuts(selection: BookmarkSelection, loaded: readonly string[]): void {
  useShortcut({ key: "x" }, () => {
    const id = focusedItem()?.dataset.itemId;
    if (id !== undefined) {
      selection.toggle(id);
    }
  });
  useShortcut({ key: "A" }, (event) => {
    event.preventDefault();
    selection.add(loaded);
  });
}
