import type { Locator, Page } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { waitForInitialFocus } from "../support/keyboard.ts";
import { expect, test } from "../support/test.ts";

// A modal dialog keeps the keyboard inside it (doc 03 section 15, doc 08 section 5.2): from the first Tab or Shift+Tab
// after it opens, the focus only moves between the dialog's own stops. The New bookmark dialog is a FormOverlay, the
// shared overlay every form over the page is built on: a dialog on a desktop screen, a sheet on a phone. The check presses
// far more keys than the overlay has stops, so it runs through the wrap-around from the last stop to the first and back,
// and it looks where the focus is after every press, not at the end, because a focus that leaves the overlay and comes
// back in is still a leak. The keys come one after the other without a pause: a person's pace is slower than the frame
// the focus guards of the dialog wait for before they move the focus back, and that frame is late in WebKit.

const PHONE = { width: 390, height: 844 };

const PRESSES = 30;

const en = (key: string): string => message("en", key, {});

/** Where the focus is: "inside" the overlay, or the element it is on, described. */
async function focusPlace(overlay: Locator): Promise<string> {
  return overlay.evaluate((root) => {
    const active = document.activeElement;
    if (active === null) {
      return "nothing";
    }
    if (root.contains(active)) {
      return "inside";
    }
    const label = active.getAttribute("aria-label") ?? active.textContent.trim().slice(0, 40);
    return `${active.tagName.toLowerCase()} ${label}`.trim();
  });
}

async function openCreateOverlay(page: Page, onPhone: boolean): Promise<Locator> {
  await page.keyboard.press("c");
  const overlay = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
  await expect(overlay).toBeVisible();
  // The overlay moves the focus a moment after it shows, to the URL field in the dialog and to the sheet itself on a
  // phone; a key pressed before that starts from the wrong place.
  await (onPhone
    ? waitForInitialFocus(overlay, "the New bookmark sheet")
    : waitForInitialFocus(overlay.getByLabel(en("bookmarks.modal.url.label"), { exact: true }), "the URL field of the New bookmark dialog"));
  return overlay;
}

for (const { name, viewport } of [
  { name: "dialog on a desktop screen", viewport: undefined },
  { name: "sheet on a 390 px wide phone", viewport: PHONE },
] as const) {
  test.describe(`the New bookmark ${name}`, () => {
    if (viewport !== undefined) {
      test.use({ viewport });
      test.skip(({ browserName }) => browserName !== "chromium", "the phone-size run is Chromium's");
    }

    for (const key of ["Tab", "Shift+Tab"]) {
      test(`keeps the focus inside it from the first ${key}`, async ({ page, app, account }) => {
        await account.set({ locale: "en" });
        await app.visit("/bookmarks", page.getByRole("heading", { level: 1, name: en("bookmarks.page.title") }));
        const overlay = await openCreateOverlay(page, viewport !== undefined);
        const places: string[] = [];
        for (let press = 0; press < PRESSES; press++) {
          await page.keyboard.press(key);
          places.push(await focusPlace(overlay));
        }
        expect(places, `where the focus is after each of ${String(PRESSES)} presses of ${key}`).toEqual(Array.from({ length: PRESSES }, () => "inside"));
        await app.scan();
      });
    }
  });
}
