import { useEffect } from "react";
import { isHttpUrl } from "./bookmarks.ts";

/** Base UI marks a toast `role="dialog"` with `aria-modal="false"`; a dialog that holds focus is not marked so. */
const OPEN_DIALOG = "[role='dialog']:not([aria-modal='false']), [role='alertdialog']:not([aria-modal='false'])";

function typesText(target: EventTarget | null): boolean {
  return target instanceof Element && (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null || (target as HTMLElement).isContentEditable);
}

/**
 * Calls `onUrl` with an address pasted anywhere on the page outside a text field (doc 02 section 5.2). A paste into a field
 * is the field's, a paste while a dialog is open (a toast is not one) belongs to the dialog, and text that is not an `http` or `https`
 * address is left alone.
 */
export function usePasteToCreate(onUrl: (url: string) => void): void {
  useEffect(() => {
    function onPaste(event: ClipboardEvent): void {
      if (event.defaultPrevented || typesText(event.target) || document.querySelector(OPEN_DIALOG) !== null) {
        return;
      }
      const text = event.clipboardData?.getData("text").trim();
      if (text === undefined || !isHttpUrl(text)) {
        return;
      }
      event.preventDefault();
      onUrl(text);
    }
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("paste", onPaste);
    };
  }, [onUrl]);
}
