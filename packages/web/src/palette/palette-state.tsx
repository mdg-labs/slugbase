import { useShortcut } from "@slugbase/ui";
import { useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { registerDefaultCommands } from "./default-commands.tsx";

/** The pages whose bookmarks, folders or tags are a list; `/` opens the palette on them. */
const LIST_PAGES = ["/bookmarks", "/folders", "/tags"];

function isListPage(pathname: string): boolean {
  return LIST_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/** The dialogs that are open besides the palette. */
function otherDialogs(): Element[] {
  return Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog']")).filter((dialog) => dialog.closest("[data-slot='command-palette']") === null);
}

interface PaletteState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** The top bar's command trigger. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  /** The element focus goes back to when the palette closes. */
  readonly focusBack: () => HTMLElement | boolean | null;
}

const PaletteStateContext = createContext<PaletteState | undefined>(undefined);

export function usePaletteState(): PaletteState {
  const state = useContext(PaletteStateContext);
  if (state === undefined) {
    throw new Error("usePaletteState needs a PaletteProvider above it");
  }
  return state;
}

function Shortcuts({ open, setOpen }: { readonly open: boolean; readonly setOpen: (open: boolean) => void }): null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Ctrl or Command with K works from anywhere, a text field included, and closes the palette while it is open.
  useShortcut({ key: "k", mod: true }, (event) => {
    event.preventDefault();
    setOpen(!open);
  });
  // `/` is a single-key shortcut: it follows the account's switch and stays quiet in text fields and overlays.
  useShortcut({ key: "/" }, (event) => {
    if (isListPage(pathname)) {
      event.preventDefault();
      setOpen(true);
    }
  });
  return null;
}

/**
 * Holds whether the command palette is open, for the top bar's trigger, the shortcuts that open it and the dialog itself, and
 * registers the default commands for as long as the app is shown (doc 03 section 9).
 */
export function PaletteProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [open, setOpenState] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dialogsAtOpen = useRef<ReadonlySet<Element>>(new Set());

  useEffect(() => registerDefaultCommands(), []);

  const setOpen = useCallback((next: boolean): void => {
    if (next) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      dialogsAtOpen.current = new Set(otherDialogs());
    }
    setOpenState(next);
  }, []);

  const focusBack = useCallback((): HTMLElement | boolean | null => {
    // A command that opened another dialog (New bookmark) leaves focus to it.
    if (otherDialogs().some((dialog) => !dialogsAtOpen.current.has(dialog))) {
      return false;
    }
    const element = opener.current;
    return element !== null && element.isConnected ? element : triggerRef.current;
  }, []);

  const state = useMemo<PaletteState>(() => ({ open, setOpen, triggerRef, focusBack }), [open, setOpen, focusBack]);

  return (
    <PaletteStateContext.Provider value={state}>
      <Shortcuts open={open} setOpen={setOpen} />
      {children}
    </PaletteStateContext.Provider>
  );
}
