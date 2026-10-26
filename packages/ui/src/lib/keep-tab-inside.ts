import type { KeyboardEvent } from "react";

const CANDIDATES =
  'a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]:not([contenteditable="false"])';

function isHidden(element: HTMLElement, container: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return true;
  }
  if (view.getComputedStyle(element).visibility !== "visible") {
    return true;
  }
  for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
    if (current.hasAttribute("inert") || current.hasAttribute("hidden") || view.getComputedStyle(current).display === "none") {
      return true;
    }
    if (current === container) {
      break;
    }
  }
  return false;
}

function isRadio(element: HTMLElement): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === "radio" && element.name !== "";
}

function sameGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  return a.name === b.name && a.form === b.form;
}

/** The elements of a container that Tab stops on, in document order; a radio group is one stop, as the browser makes it. */
function tabStops(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(CANDIDATES)).filter(
    (element) =>
      !element.hasAttribute("data-base-ui-focus-guard") &&
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !(element instanceof HTMLInputElement && element.type === "hidden") &&
      !isHidden(element, container),
  );
  return candidates.filter((element) => {
    if (!isRadio(element)) {
      return true;
    }
    const group = candidates.filter((other): other is HTMLInputElement => isRadio(other) && sameGroup(other, element));
    return (group.find((radio) => radio.checked) ?? group[0]) === element;
  });
}

/**
 * Keeps Tab and Shift+Tab inside a modal popup, at the moment the key is pressed: from its last stop Tab goes to the
 * first and from its first stop Shift+Tab goes to the last. The popup's own focus guards do the same, but only on the
 * animation frame after the browser has moved the focus onto them, and in WebKit that frame can be hundreds of
 * milliseconds late while the popup's backdrop animates, so a key pressed before it carries the focus out of the
 * dialog. The guards stay as the fallback for a focus that arrives by other means.
 *
 * Meant for `onKeyDown` of the popup element. A key pressed inside a popup that opened from this one is left to that one.
 */
export function keepTabInside(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const popup = event.currentTarget;
  const active = popup.ownerDocument.activeElement;
  if (active === null || !popup.contains(active)) {
    return;
  }
  const stops = tabStops(popup);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    return;
  }
  if (event.shiftKey ? active === first || active === popup : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
