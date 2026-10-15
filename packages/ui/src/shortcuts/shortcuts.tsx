import { createContext, useContext, useEffect, useRef, type ReactElement, type ReactNode } from "react";

/**
 * The keyboard shortcut layer (doc 03 section 14, Q38). A shortcut is either a modifier shortcut, which holds
 * Ctrl or Command and always works, or a single-key shortcut, which the account can turn off because
 * character-key shortcuts trigger by accident for speech-input and screen-reader users (WCAG 2.1.4).
 */
export interface ShortcutBinding {
  /** The `KeyboardEvent.key` the shortcut answers to, for example `c` or `?`. A single-key shortcut matches that exact key (`c` does not fire on Shift+C); a modifier shortcut matches a letter in either case. */
  key: string;
  /** Ctrl or Command with the key. A modifier shortcut is never switched off. */
  mod?: boolean;
}

const ShortcutsContext = createContext<boolean>(true);

export interface ShortcutsProviderProps {
  /** Whether single-key shortcuts are on; the account's setting, on by default. */
  singleKey: boolean;
  children: ReactNode;
}

/** Tells every shortcut below it whether single-key shortcuts are on. */
export function ShortcutsProvider({ singleKey, children }: ShortcutsProviderProps): ReactElement {
  return <ShortcutsContext.Provider value={singleKey}>{children}</ShortcutsContext.Provider>;
}

function typesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']") !== null;
}

function matches(event: KeyboardEvent, { key, mod = false }: ShortcutBinding): boolean {
  const same = event.key === key || event.key.toLowerCase() === key.toLowerCase();
  if (mod) {
    return same && (event.metaKey || event.ctrlKey);
  }
  return event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * Runs `handler` when the shortcut is pressed. A single-key shortcut is skipped while single-key shortcuts
 * are off and while focus is in a field that takes text; a modifier shortcut runs either way.
 */
export function useShortcut(binding: ShortcutBinding, handler: (event: KeyboardEvent) => void): void {
  const singleKey = useContext(ShortcutsContext);
  const latest = useRef(handler);
  latest.current = handler;
  const { key, mod = false } = binding;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || !matches(event, { key, mod })) {
        return;
      }
      if (!mod && (!singleKey || typesText(event.target))) {
        return;
      }
      latest.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [key, mod, singleKey]);
}
