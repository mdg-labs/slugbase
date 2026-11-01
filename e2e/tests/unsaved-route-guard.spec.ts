import { randomBytes } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { appOrigin } from "../support/environment.ts";
import { openPaletteWithShortcut, paletteDialog } from "../support/palette.ts";
import { expect, test, type App } from "../support/test.ts";

// A route change behind an edited form over the page (doc 03 `form-overlay`, `unsaved-guard`), in a real browser: the Back and Forward
// buttons and a palette command ask the discard question first, for every route that opens a form overlay. Keeping the form leaves
// the address and the typed text as they were; discarding completes the navigation that was asked for; a form with no edit, and one
// that has saved, ask nothing. Nothing is saved on the server: no journey presses a save button.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

interface Opened {
  readonly dialog: Locator;
  /** The field that takes the edit. */
  readonly field: Locator;
  /** Where the app is when the form is open, as a pathname. */
  readonly path: string;
  /** Opens the form on the page, when the page does not show it already. */
  readonly show: () => Promise<void>;
}

interface FormCase {
  readonly name: string;
  /** Goes to the page of the form by the app's own navigation, so that Back has an entry of the app to return to, and opens the form. */
  readonly open: (page: Page, app: App) => Promise<Opened>;
  /** The address Back returns to, as a pathname with its query. */
  readonly before: string;
}

const NAV = (page: Page): Locator => page.getByRole("navigation", { name: en("shell.navigation"), exact: true });
const SETTINGS_NAV = (page: Page): Locator => page.getByRole("navigation", { name: en("settings.navigation"), exact: true });

/** A form that a button of its page opens: `show` presses it unless the form is open already. */
async function opened(dialog: Locator, field: Locator, path: string, press: () => Promise<void>): Promise<Opened> {
  const show = async (): Promise<void> => {
    if (!(await dialog.isVisible())) {
      await press();
    }
    await expect(dialog).toBeVisible();
  };
  await show();
  return { dialog, field, path, show };
}

const CASES: readonly FormCase[] = [
  {
    name: "the bookmark form",
    before: "/bookmarks",
    open: async (page, app) => {
      await app.visit("/bookmarks", page.getByRole("heading", { level: 1, name: en("shell.bookmarks"), exact: true }));
      const dialog = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
      return opened(dialog, dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true }), "/bookmarks", async () => {
        await page.getByRole("banner").getByRole("button", { name: en("bookmarks.new"), exact: true }).click();
      });
    },
  },
  {
    name: "the folder form",
    before: "/folders",
    open: async (page, app) => {
      await app.visit("/folders", page.getByRole("heading", { level: 1, name: en("shell.folders"), exact: true }));
      const dialog = page.getByRole("dialog", { name: en("folders.form.title.create"), exact: true });
      return opened(dialog, dialog.getByRole("textbox", { name: en("folders.form.name.label"), exact: true }), "/folders", async () => {
        await page.getByRole("button", { name: en("folders.new"), exact: true }).first().click();
      });
    },
  },
  {
    name: "the tag rename form",
    before: "/",
    open: async (page, app) => {
      const token = randomBytes(4).toString("hex");
      const made = await page.request.post("/api/v1/tags", { headers: { origin: appOrigin(), "content-type": "application/json" }, data: { name: `guard-${token}` } });
      expect(made.status(), "POST /api/v1/tags").toBe(201);
      await app.visit("/", page.getByRole("heading", { level: 1 }));
      await NAV(page).getByRole("link", { name: en("shell.tags"), exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: en("tags.page.title"), exact: true })).toBeVisible();
      const dialog = page.getByRole("dialog", { name: en("tags.form.title"), exact: true });
      return opened(dialog, dialog.getByRole("textbox", { name: en("tags.form.name.label"), exact: true }), "/tags", async () => {
        await page.getByRole("button", { name: en("tags.list.actionsFor", { name: `guard-${token}` }), exact: true }).click();
        await page.getByRole("menuitem", { name: en("tags.actions.rename"), exact: true }).click();
      });
    },
  },
  {
    name: "the team form",
    before: "/settings/workspace",
    open: async (page, app) => {
      await app.visit("/settings/workspace", page.getByRole("heading", { level: 1 }));
      await SETTINGS_NAV(page).getByRole("link", { name: en("settings.nav.teams"), exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: en("teams.title"), exact: true })).toBeVisible();
      const dialog = page.getByRole("dialog", { name: en("teams.form.title.create"), exact: true });
      return opened(dialog, dialog.getByRole("textbox", { name: en("teams.form.name.label"), exact: true }), "/settings/workspace/teams", async () => {
        await page.getByRole("button", { name: en("teams.create"), exact: true }).first().click();
      });
    },
  },
  {
    name: "the API token form",
    before: "/settings/account",
    open: async (page, app) => {
      await app.visit("/settings/account", page.getByRole("heading", { level: 1 }));
      await SETTINGS_NAV(page).getByRole("link", { name: en("settings.nav.tokens"), exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: en("settings.tokens.title"), exact: true })).toBeVisible();
      const dialog = page.getByRole("dialog", { name: en("settings.tokens.create.title"), exact: true });
      return opened(dialog, dialog.getByRole("textbox", { name: en("settings.tokens.name.label"), exact: true }), "/settings/account/tokens", async () => {
        await page.getByRole("button", { name: en("settings.tokens.new"), exact: true }).first().click();
      });
    },
  },
];

function question(page: Page): Locator {
  return page.getByRole("alertdialog", { name: en("unsaved.title"), exact: true });
}

async function paletteGoHome(page: Page): Promise<void> {
  await openPaletteWithShortcut(page);
  await paletteDialog(page)
    .getByRole("option", { name: new RegExp(`^${en("palette.command.home.name")}`) })
    .first()
    .click();
}

function address(page: Page): string {
  const { pathname, search } = new URL(page.url());
  return pathname + search;
}

for (const form of CASES) {
  test.describe(`${form.name} behind a route change`, () => {
    test("asks on Back, keeps the form and the text on Keep editing, and goes back on Discard", async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      const { dialog, field, path } = await form.open(page, app);
      await app.scan();
      await field.fill("an edit");

      await page.goBack();
      await expect(question(page)).toBeVisible();
      await question(page).getByRole("button", { name: en("unsaved.keepEditing"), exact: true }).click();

      await expect(question(page)).toBeHidden();
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue("an edit");
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);

      await page.goBack();
      await question(page).getByRole("button", { name: en("unsaved.discard"), exact: true }).click();

      await expect(dialog).toBeHidden();
      await expect.poll(() => address(page)).toBe(form.before);
      await app.scan();
    });

    test("asks on Forward, keeps the form on Keep editing, and goes forward on Discard", async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      const { dialog, field, path, show } = await form.open(page, app);
      await app.scan();
      // With no edit, a palette command leaves the form and asks nothing; Back then returns to the form's page.
      await paletteGoHome(page);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/");
      await expect(question(page)).toBeHidden();
      await app.scan();
      await page.goBack();
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);
      await show();
      await field.fill("an edit");

      await page.goForward();
      await expect(question(page)).toBeVisible();
      await question(page).getByRole("button", { name: en("unsaved.keepEditing"), exact: true }).click();

      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue("an edit");
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);

      await page.goForward();
      await question(page).getByRole("button", { name: en("unsaved.discard"), exact: true }).click();

      await expect(dialog).toBeHidden();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/");
      await app.scan();
    });

    test("asks on a palette command, keeps the form on Keep editing, and goes to the page on Discard", async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      const { dialog, field, path } = await form.open(page, app);
      await app.scan();
      await field.fill("an edit");

      await paletteGoHome(page);

      await expect(question(page)).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(path);
      await question(page).getByRole("button", { name: en("unsaved.keepEditing"), exact: true }).click();
      await expect(question(page)).toBeHidden();
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue("an edit");
      expect(new URL(page.url()).pathname).toBe(path);

      await paletteGoHome(page);
      await question(page).getByRole("button", { name: en("unsaved.discard"), exact: true }).click();

      await expect(dialog).toBeHidden();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/");
      await app.scan();
    });

    test("asks nothing when the form has no edit", async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      const { dialog } = await form.open(page, app);
      await app.scan();

      await paletteGoHome(page);

      await expect.poll(() => new URL(page.url()).pathname).toBe("/");
      await expect(dialog).toBeHidden();
      await expect(question(page)).toBeHidden();
      await app.scan();
    });
  });
}

// Two presses of Back while the question is open: the history moves the browser back to the page for each press, and the
// router and the address must still agree afterwards. The stack is /bookmarks, /folders, /tags (all by the app's own
// navigation, one document), with the tag rename form open on /tags.
test.describe("two traversals during one question", () => {
  async function openOnThirdEntry(page: Page, app: App): Promise<{ dialog: Locator; field: Locator }> {
    const token = randomBytes(4).toString("hex");
    const made = await page.request.post("/api/v1/tags", { headers: { origin: appOrigin(), "content-type": "application/json" }, data: { name: `guard-${token}` } });
    expect(made.status(), "POST /api/v1/tags").toBe(201);
    const heading = (name: string): Locator => page.getByRole("heading", { level: 1, name, exact: true });
    await app.visit("/bookmarks", heading(en("shell.bookmarks")));
    await NAV(page).getByRole("link", { name: en("shell.folders"), exact: true }).click();
    await expect(heading(en("shell.folders"))).toBeVisible();
    await app.scan();
    await NAV(page).getByRole("link", { name: en("shell.tags"), exact: true }).click();
    await expect(heading(en("tags.page.title"))).toBeVisible();
    await app.scan();
    await page.getByRole("button", { name: en("tags.list.actionsFor", { name: `guard-${token}` }), exact: true }).click();
    await page.getByRole("menuitem", { name: en("tags.actions.rename"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: en("tags.form.title"), exact: true });
    const field = dialog.getByRole("textbox", { name: en("tags.form.name.label"), exact: true });
    await expect(dialog).toBeVisible();
    await field.fill("an edit");
    // Counts the popstate events of the document: two presses, and the history's move back for the second one.
    await page.evaluate(() => {
      const counted = window as unknown as { __pops: number };
      counted.__pops = 0;
      window.addEventListener("popstate", () => {
        counted.__pops += 1;
      });
    });
    return { dialog, field };
  }

  async function pressBackTwice(page: Page): Promise<void> {
    // The second press comes while the question about the first is open.
    await page.evaluate(() => {
      window.history.back();
    });
    await expect(question(page)).toBeVisible();
    await page.evaluate(() => {
      window.history.back();
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pops: number }).__pops)).toBe(3);
    expect(address(page)).toBe("/tags");
  }

  test("keeps the form and still asks on the next Back after Keep editing", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const { dialog, field } = await openOnThirdEntry(page, app);

    await pressBackTwice(page);
    await question(page).getByRole("button", { name: en("unsaved.keepEditing"), exact: true }).click();

    await expect(question(page)).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue("an edit");
    expect(address(page)).toBe("/tags");

    await page.goBack();
    await expect(question(page)).toBeVisible();
    await question(page).getByRole("button", { name: en("unsaved.discard"), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => address(page)).toBe("/folders");
    await expect(page.getByRole("heading", { level: 1, name: en("shell.folders"), exact: true })).toBeVisible();
    await app.scan();
  });

  test("lands on the page of the last press after Discard, with the router on it", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const { dialog } = await openOnThirdEntry(page, app);

    await pressBackTwice(page);
    await question(page).getByRole("button", { name: en("unsaved.discard"), exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect.poll(() => address(page)).toBe("/bookmarks");
    await expect(page.getByRole("heading", { level: 1, name: en("shell.bookmarks"), exact: true })).toBeVisible();
    await app.scan();
    // The router and the address agree: Forward returns to the folders page by the router.
    await page.goForward();
    await expect.poll(() => address(page)).toBe("/folders");
    await expect(page.getByRole("heading", { level: 1, name: en("shell.folders"), exact: true })).toBeVisible();
    await app.scan();
  });
});
