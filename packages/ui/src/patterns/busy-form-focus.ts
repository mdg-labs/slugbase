import { useLayoutEffect, useRef } from "react";
import type { FocusEvent, RefObject } from "react";

/** What a form in a `FormOverlay` spreads onto its `<form>` element. */
export interface BusyFormFocus {
  /** The ref the hook reads the form from. */
  ref: RefObject<HTMLFormElement | null>;
  /** Remembers the field that had the focus last. */
  onFocus: (event: FocusEvent<HTMLFormElement>) => void;
  /** Present while the form is busy, so assistive technology learns the form is working. */
  "aria-busy": true | undefined;
}

function isLost(active: Element | null, form: HTMLFormElement): boolean {
  const document = form.ownerDocument;
  if (active === null || active === document.body || active === document.documentElement) {
    return true;
  }
  // A browser may leave a field that was disabled under the focus as the active element until its next frame.
  return form.contains(active) && active.matches(":disabled");
}

/**
 * Keeps the focus inside a form overlay while its form saves. A form disables its fields while it is busy, and a browser
 * drops the focus of a field that is disabled under it onto the page body, where it stays after a refusal and where a Tab
 * reaches the page behind the overlay. While `busy`, the focus a field loses goes to the overlay itself; when the form is
 * free again (a refusal leaves it open) it goes back to the field that had it.
 *
 * Spread the result onto the `<form>`: it carries the ref the hook reads the form from, the focus listener that remembers
 * the active field, and `aria-busy` for the busy state.
 */
export function useBusyFormFocus(busy: boolean): BusyFormFocus {
  const ref = useRef<HTMLFormElement>(null);
  const lastField = useRef<HTMLElement | null>(null);
  const held = useRef(false);

  useLayoutEffect(() => {
    const form = ref.current;
    if (form === null) {
      return;
    }
    const overlay = form.closest<HTMLElement>('[data-slot="form-overlay"]');
    if (overlay === null) {
      return;
    }
    if (busy) {
      if (isLost(form.ownerDocument.activeElement, form)) {
        overlay.focus({ preventScroll: true });
        held.current = true;
      }
      return;
    }
    if (!held.current) {
      return;
    }
    held.current = false;
    const active = form.ownerDocument.activeElement;
    const field = lastField.current;
    // Only a focus that is still where it was put is moved back, and only into an overlay that has not started to close.
    if (field?.isConnected !== true || field.matches(":disabled") || !overlay.hasAttribute("data-open")) {
      return;
    }
    if (active === null || active === form.ownerDocument.body || active === overlay) {
      field.focus({ preventScroll: true });
    }
  }, [busy]);

  return {
    ref,
    onFocus: (event) => {
      if (event.target instanceof HTMLElement) {
        lastField.current = event.target;
      }
    },
    "aria-busy": busy ? true : undefined,
  };
}
