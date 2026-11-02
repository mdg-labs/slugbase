import { useLayoutEffect, useState } from "react";

/** Where the app is, or is going: the path and the raw query string (`?a=1`, or empty) of an address. */
export interface FormAddress {
  readonly pathname: string;
  readonly search: string;
}

/** Whether a form is still on screen once the app has moved from `current` to `next`. */
export type FormStays = (next: FormAddress, current: FormAddress) => boolean;

/** A form that belongs to its page: it stays while the path stays. This is what `useUnsavedForm` assumes. */
export const staysOnPage: FormStays = (next, current) => next.pathname === current.pathname;

/** A form that the address opens with query parameters: it stays while the values of those parameters stay, on whatever path. */
export function staysWhileParams(...names: readonly string[]): FormStays {
  return (next, current) => {
    const before = new URLSearchParams(current.search);
    const after = new URLSearchParams(next.search);
    return names.every((name) => before.get(name) === after.get(name));
  };
}

/** The forms that hold unsaved edits, for the part of the app that sits where a route change can be held (a router's blocker). */
export interface UnsavedChanges {
  /** Whether any mounted form holds edits that the member has not saved or discarded. */
  hasUnsaved: () => boolean;
  /** Whether a form holds such edits that moving from `current` to `next` takes off the screen. */
  holds: (change: { readonly current: FormAddress; readonly next: FormAddress }) => boolean;
  /** Marks every form as settled, once the member has chosen to lose the edits. */
  releaseAll: () => void;
  /** Calls `listener` whenever `hasUnsaved` may have changed; returns the way to stop. */
  subscribe: (listener: () => void) => () => void;
}

interface Entry {
  dirty: boolean;
  stays: FormStays;
}

const entries = new Set<Entry>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) {
    listener();
  }
}

function anyDirty(): boolean {
  for (const entry of entries) {
    if (entry.dirty) {
      return true;
    }
  }
  return false;
}

/** The unsaved edits of the forms that report with `useUnsavedForm`. */
export const unsavedChanges: UnsavedChanges = {
  hasUnsaved: anyDirty,
  holds: ({ current, next }) => {
    for (const entry of entries) {
      if (entry.dirty && !entry.stays(next, current)) {
        return true;
      }
    }
    return false;
  },
  releaseAll: () => {
    for (const entry of entries) {
      entry.dirty = false;
    }
    changed();
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Reports whether a form holds unsaved edits while it is mounted, so a route change that would take it off the screen can ask first.
 * `stays` says which changes leave the form where it is (by default, those within its page). The returned `release` ends the
 * report until `dirty` changes again: a form calls it when its edits are saved or discarded and it is about to navigate, so its
 * own navigation is not held.
 */
export function useUnsavedForm(dirty: boolean, stays: FormStays = staysOnPage): { release: () => void } {
  const [entry] = useState<Entry>(() => ({ dirty: false, stays }));
  useLayoutEffect(() => {
    entry.stays = stays;
  });
  useLayoutEffect(() => {
    entries.add(entry);
    return () => {
      entries.delete(entry);
      changed();
    };
  }, [entry]);
  useLayoutEffect(() => {
    entry.dirty = dirty;
    changed();
  }, [entry, dirty]);
  return {
    release: () => {
      entry.dirty = false;
      changed();
    },
  };
}
