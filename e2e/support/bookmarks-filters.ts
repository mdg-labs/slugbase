import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { message } from "./catalog.ts";

// The Filters panel of the Bookmarks toolbar (doc 03 section 3.1): the folder, the tags and the "show only"
// checkboxes sit in a side panel that the Filters button opens, and the chips under the toolbar row name each filter
// that is set. A journey reaches those filters through these helpers, so that the way to them is written once.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

/** The Filters button of the toolbar, named by the number of filters of the panel that are set, if any are. */
export function filtersButton(page: Page, set = 0): Locator {
  return page.getByRole("button", { name: set === 0 ? en("bookmarks.list.filters.button") : en("bookmarks.list.filters.buttonCount", { count: String(set) }), exact: true });
}

/** The panel that the Filters button opens. */
export function filtersPanel(page: Page): Locator {
  return page.getByRole("dialog", { name: en("bookmarks.list.filters.title"), exact: true });
}

/** The chips under the toolbar row, which name each filter that is set. */
export function filterChips(page: Page): Locator {
  return page.getByRole("list", { name: en("bookmarks.list.filters.active"), exact: true });
}

/** Opens the Filters panel unless it is open, and returns it. */
export async function openFilters(page: Page): Promise<Locator> {
  const panel = filtersPanel(page);
  if (!(await panel.isVisible())) {
    // The name is the label alone or the label and the count, so it is matched from its start; "Clear filters" and "Close filters" do not start with it.
    await page.getByRole("button", { name: new RegExp(`^${en("bookmarks.list.filters.button")}`) }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the Filters panel with its close button, so that the page behind it can be reached. */
export async function closeFilters(page: Page): Promise<void> {
  const panel = filtersPanel(page);
  if (await panel.isVisible()) {
    await panel.getByRole("button", { name: en("bookmarks.list.filters.close"), exact: true }).click();
  }
  await expect(panel).toHaveCount(0);
}
