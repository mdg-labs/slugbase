// The keyboard steps of the journeys: what they press and what they wait for first. A page needs only a keyboard and an
// element only a way to ask whether it holds the focus, so a Playwright `Page` and `Locator` fit and a unit test can stand
// in a page of its own (support/keyboard.test.ts).

/** The part of a Playwright `Page` the keyboard steps use. */
export interface KeyboardPage {
  keyboard: { press(key: string): Promise<void> };
}

/**
 * The part of a Playwright `Locator` the keyboard steps use. `timeout` bounds the wait for the element itself, which the
 * locator otherwise waits for until the test's own timeout.
 */
export interface FocusTarget {
  evaluate(pageFunction: (element: Element) => boolean, arg?: undefined, options?: { timeout?: number }): Promise<boolean>;
}

/** Tab presses `tabTo` makes before it gives up. */
export const TAB_BUDGET = 20;

/** How long an opened dialog may take to move the focus to its initial target, in milliseconds. */
export const INITIAL_FOCUS_TIMEOUT = 5000;

const POLL_INTERVAL = 25;

function holdsFocus(target: FocusTarget, options?: { timeout: number }): Promise<boolean> {
  return target.evaluate((element) => element === document.activeElement, undefined, options);
}

/**
 * Waits until the element has the focus, without pressing a key. A dialog moves the focus to its initial target a moment
 * after it is visible; a Tab pressed before that moves the focus from the wrong place and the keyboard steps after it no
 * longer start where they expect, so a journey that opens a dialog and then tabs waits for the initial focus first. The
 * deadline also bounds the wait for the element to exist, so a field that never mounts fails here and names itself.
 */
export async function waitForInitialFocus(target: FocusTarget, what: string, timeout = INITIAL_FOCUS_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeout;
  const missed = (cause?: unknown) => new Error(`${what} has the initial focus within ${String(timeout)} ms`, { cause });
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw missed();
    }
    let focused: boolean;
    try {
      focused = await holdsFocus(target, { timeout: remaining });
    } catch (error) {
      if (Date.now() >= deadline) {
        throw missed(error);
      }
      throw error;
    }
    if (focused) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/** Presses Tab until the element has focus; the keyboard is the only input that moves it. */
export async function tabTo(page: KeyboardPage, target: FocusTarget, presses = TAB_BUDGET): Promise<void> {
  for (let press = 0; press < presses; press++) {
    if (await holdsFocus(target)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  if (!(await holdsFocus(target))) {
    throw new Error(`Tab reaches the element within ${String(presses)} presses`);
  }
}
