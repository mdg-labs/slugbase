import type { NavigateOptions } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useSyncExternalStore, type ReactElement } from "react";

/** The groups of commands the palette lists; a command of a later epic (Import, Export) joins one of them. */
export type CommandGroupId = "navigation" | "actions";

/** What a command can do, and what it can tell about where it runs. */
export interface PaletteContext {
  /** Goes to a page of the app, with the search parameters that page declares. */
  readonly navigate: (options: NavigateOptions) => void;
  /** Opens the bookmark modal over the current page. */
  readonly openNewBookmark: () => void;
  /** Whether the account acts in a workspace to save bookmarks to. */
  readonly canSaveBookmarks: boolean;
  /** Turns the theme to the other of light and dark, and saves the choice. */
  readonly toggleTheme: () => void;
  readonly signOut: () => void;
  /** Replaces the palette's list with the account's workspaces, to switch to one. */
  readonly showWorkspaces: () => void;
}

export interface PaletteCommand {
  /** Keys the command; registering another with the same id replaces it. */
  readonly id: string;
  readonly group: CommandGroupId;
  /** The name, in the language of the page. */
  readonly name: (t: TFunction) => string;
  /** The words besides the name that the query matches, in the language of the page. */
  readonly keywords: (t: TFunction) => string;
  /** A decorative icon. */
  readonly icon?: ReactElement;
  /** The keys of the command's own shortcut, shown at the end of its row. */
  readonly shortcut?: readonly string[];
  /** Where the command sits in its group, the lowest first; commands with the same order keep the order they were registered in. */
  readonly order?: number;
  /** Whether the command is on offer; one that is not is left out of the list. */
  readonly when?: (context: PaletteContext) => boolean;
  /** Keeps the palette open after the command ran, for a command that goes on in the palette itself. */
  readonly keepOpen?: boolean;
  readonly run: (context: PaletteContext) => void;
}

const DEFAULT_ORDER = 1000;

const registered = new Map<string, PaletteCommand>();
const listeners = new Set<() => void>();
let snapshot: readonly PaletteCommand[] = [];

function publish(): void {
  snapshot = [...registered.values()].sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Adds a command to the palette and returns the function that takes it away again. This is the one place commands come from: the
 * default ones are registered by the app shell, and a feature adds its own (Import, Export) the same way.
 */
export function registerCommand(command: PaletteCommand): () => void {
  registered.set(command.id, command);
  publish();
  return () => {
    if (registered.get(command.id) === command) {
      registered.delete(command.id);
      publish();
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered commands, ordered, and again when one is added or removed. */
export function useCommands(): readonly PaletteCommand[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
