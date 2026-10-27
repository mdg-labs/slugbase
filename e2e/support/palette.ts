import type { Locator, Page } from "@playwright/test";
import { message } from "./catalog.ts";
import { waitForInitialFocus } from "./keyboard.ts";
import { expect } from "./test.ts";

// The command palette as the journeys find it (doc 03 section 9): the dialog, its input and its options, read by role and by the
// names of the catalogs of packages/web, and the keyboard steps that open it and watch its highlight.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

/** The palette's dialog, named by its title, which is not drawn. */
export function paletteDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: en("palette.title"), exact: true });
}

/** The palette's input, the combobox that holds the focus while the palette is open. */
export function paletteInput(page: Page): Locator {
  return paletteDialog(page).getByRole("combobox", { name: en("palette.input"), exact: true });
}

/** The options of one group of the palette, such as "Bookmarks", in the order they are listed. */
export function paletteGroup(page: Page, name: string): Locator {
  return paletteDialog(page).getByRole("group", { name, exact: true }).getByRole("option");
}

/** Opens the palette with Ctrl (Command on a Mac) and K and waits until the input has the focus. */
export async function openPaletteWithShortcut(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+K");
  await expect(paletteDialog(page)).toBeVisible();
  await waitForInitialFocus(paletteInput(page), "the palette's input");
}

/** Waits until the option is the one the input names as its active descendant, which is the one Enter acts on. */
export async function expectHighlighted(page: Page, option: Locator): Promise<void> {
  await expect(async () => {
    const id = await option.getAttribute("id", { timeout: 1000 });
    expect(id, "the option has an id").not.toBeNull();
    await expect(paletteInput(page)).toHaveAttribute("aria-activedescendant", id ?? "", { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}
