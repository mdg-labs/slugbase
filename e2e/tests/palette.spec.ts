import { randomBytes } from "node:crypto";
import type { APIRequestContext, Dialog, Locator, Page, PlaywrightWorkerArgs } from "@playwright/test";
import { bookmarkBody, bookmarkShape } from "../support/bookmark-fixtures.ts";
import { message } from "../support/catalog.ts";
import { DESTINATION_HEADING, startDestination, type Destination } from "../support/destination.ts";
import { appOrigin } from "../support/environment.ts";
import { WORKSPACE_NAME } from "../support/instance.ts";
import { tabTo, waitForInitialFocus } from "../support/keyboard.ts";
import { ensureSharedMember, sharedMemberState } from "../support/member.ts";
import { expectHighlighted, openPaletteWithShortcut, paletteDialog, paletteGroup, paletteInput } from "../support/palette.ts";
import { expect, test } from "../support/test.ts";

// The command palette journey (doc 08 sections 5.1 and 5.2, doc 03 sections 9 and 15, doc 02 sections 9.1 and 9.2, doc 10 T14, Q39),
// after the first-run setup (tests/first-run.setup.ts): a member opens the palette from the keyboard, finds a bookmark by its exact slug
// before one that only has the slug in its title and by a typo in a title, opens it, opens another with Ctrl (Command) and Enter in a
// new tab, and edits one with Alt and Enter; `go <slug>` forwards to the destination and a slug nobody has shows the hint to create it;
// a bookmark whose title is markup is listed as text. After the page has loaded the journey touches nothing but the keyboard, and each
// state of the palette it reaches is scanned for WCAG 2.2 AA violations (tests/axe.spec.ts, support/axe.ts). It runs on a desktop screen
// in each engine and on a 390 px wide phone in Chromium (Q39). Every text is read from the catalogs of packages/web.
//
// The owner of the instance signed in with a password nobody keeps, and the journeys that read the owner's language queue for the lock
// of the account's preferences, so the journey acts as a member of its own (support/member.ts, shared by the runs of the engines, which
// accept one invitation between them). The palette lists and searches only that member's bookmarks, which each run makes through the
// API with a token of the run in every word it searches for and removes when it ends.

const PHONE = { width: 390, height: 844 };

const BOOKMARKS = "/api/v1/bookmarks";


const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("bookmarks.page.title") });
}

/** The page is not wider than the screen, so there is nothing to scroll sideways to (Q39). */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the page is wider than the screen by this many pixels").toBeLessThanOrEqual(0);
}

/** A dialog lies within the screen, on a phone as on a desktop. */
async function expectWithinScreen(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox();
  const size = page.viewportSize();
  expect(box, "the dialog has a box").not.toBeNull();
  expect(size, "the page has a viewport").not.toBeNull();
  if (box !== null && size !== null) {
    expect(box.x, "the dialog starts within the screen").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "the dialog ends within the screen").toBeLessThanOrEqual(size.width);
  }
}

/** The bookmark the API stored; the response of a refused request is part of the failure. */
async function createBookmark(member: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const response = await member.post(BOOKMARKS, { headers: { origin: appOrigin(), "content-type": "application/json" }, data: body });
  const text = await response.text();
  expect(response.status(), `POST /api/v1/bookmarks answered ${text}`).toBe(201);
  return (JSON.parse(text) as { id: string }).id;
}

/** Types into the focused element key by key, as a person at the keyboard does. */
async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
}

for (const { name, viewport } of [
  { name: "on a desktop screen", viewport: undefined },
  { name: "on a 390 px wide phone", viewport: PHONE },
] as const) {
  test.describe(`palette journey ${name}`, () => {
    if (viewport !== undefined) {
      test.use({ viewport });
      // The phone-size run is one engine's, as the others are.
      test.skip(({ browserName }) => browserName !== "chromium", "the phone-size run is Chromium's");
    }

    const token = randomBytes(4).toString("hex");
    const slugWord = `exact${token}`;
    const typoWord = `Cardamom${token}`;
    const typoQuery = `Cardamon${token}`;
    const goSlug = `hop${token}`;
    const missingSlug = `nobody${token}`;
    const hostileWord = `mark${token}`;
    const slugTitle = `Atlas ${token}`;
    const titleOnly = `${slugWord} handbook`;
    const goTitle = `Hop ${token}`;
    const hostileTitle = `${bookmarkShape("markup-title").title} ${hostileWord}`;
    let destination: Destination | undefined;
    let bookmarkId: string | undefined;
    const ids: string[] = [];

    test.use({ storageState: sharedMemberState("palette") });

    /** A request context of the member, which the bookmarks of the run are made and removed through. */
    const asMember = (playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> =>
      playwright.request.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, storageState: sharedMemberState("palette") });

    test.beforeAll(async ({ playwright }) => {
      destination = await startDestination();
      await ensureSharedMember(playwright, "palette");
      const member = await asMember(playwright);
      try {
        bookmarkId = await createBookmark(member, { url: destination.url("/by-slug"), title: slugTitle, slug: slugWord });
        ids.push(bookmarkId);
        ids.push(await createBookmark(member, { url: destination.url("/by-title"), title: titleOnly }));
        ids.push(await createBookmark(member, { url: destination.url("/by-typo"), title: typoWord }));
        ids.push(await createBookmark(member, { url: destination.url("/via-go"), title: goTitle, slug: goSlug }));
        ids.push(await createBookmark(member, { ...bookmarkBody(bookmarkShape("markup-title")), title: hostileTitle }));
      } finally {
        await member.dispose();
      }
    });

    test.afterAll(async ({ playwright }) => {
      const refused: number[] = [];
      try {
        const member = await asMember(playwright);
        try {
          for (const id of ids) {
            // A mutation must come from the app's origin and be JSON, with or without a body.
            const removed = await member.delete(`${BOOKMARKS}/${id}`, { headers: { origin: appOrigin(), "content-type": "application/json" } });
            if (removed.status() !== 204 && removed.status() !== 404) {
              refused.push(removed.status());
            }
          }
        } finally {
          await member.dispose();
        }
      } finally {
        await destination?.close();
      }
      if (refused.length > 0) {
        throw new Error(`DELETE /api/v1/bookmarks/{id} answered ${refused.join(", ")} while the journey removed what it made`);
      }
    });

    test("finds, opens, opens in a new tab and edits a bookmark, goes to a slug and lists markup as text, from the keyboard alone", async ({ page, context, app }) => {
      test.setTimeout(240_000);
      if (destination === undefined || bookmarkId === undefined) {
        throw new Error("the destination and the bookmarks were not set up before the journey");
      }
      const target = destination;
      const editedId = bookmarkId;

      // A toast of an earlier step is not part of the page under test, and a toast does not go while the pointer rests on its stack.
      const scan = async (): Promise<void> => {
        await page.mouse.move(0, 0);
        await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
        await app.scan();
      };

      const dialogs: string[] = [];
      page.on("dialog", (dialog: Dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });

      const bookmarkOptions = (): Locator => paletteGroup(page, en("palette.group.bookmarks"));
      const reaches = async (path: string): Promise<void> => {
        await expect(page).toHaveURL(target.url(path));
        await expect(page.getByRole("heading", { level: 1, name: DESTINATION_HEADING })).toBeVisible();
        await scan();
        expect(target.requests(), "what the destination was asked for").toContain(path);
      };
      const startOnList = async (): Promise<void> => {
        await app.visit("/bookmarks", listHeading(page));
      };

      await test.step("opens from the trigger with Tab and Enter, lists the commands, moves the highlight and gives the focus back on Escape", async () => {
        await startOnList();
        const trigger = page.getByRole("button", { name: en("palette.trigger"), exact: true });
        await tabTo(page, trigger, 40);
        await page.keyboard.press("Enter");
        const dialog = paletteDialog(page);
        await expect(dialog).toBeVisible();
        await waitForInitialFocus(paletteInput(page), "the palette's input");
        await expect(paletteGroup(page, en("palette.group.navigation")).first()).toBeVisible();
        await expect(paletteGroup(page, en("palette.group.actions")).first()).toBeVisible();
        // The close button is for phones, which have no Esc key.
        const close = dialog.getByRole("button", { name: en("palette.close"), exact: true });
        if (viewport === undefined) {
          await expect(close).toBeHidden();
        } else {
          await expect(close).toBeVisible();
        }
        await expectWithinScreen(page, dialog);
        await expectNoSidewaysScroll(page);
        await scan();

        const options = dialog.getByRole("option");
        await expectHighlighted(page, options.first());
        await page.keyboard.press("ArrowDown");
        await expectHighlighted(page, options.nth(1));
        await page.keyboard.press("ArrowUp");
        await expectHighlighted(page, options.first());

        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      });

      await test.step("finds a bookmark by its exact slug before one with the slug in its title, and opens it", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, slugWord);
        const options = bookmarkOptions();
        // The other bookmarks of the run share the token with these two and follow them by similarity.
        await expect(options.nth(0)).toContainText(slugTitle);
        await expect(options.nth(0)).toContainText(`/go/${slugWord}`);
        await expect(options.nth(1)).toContainText(titleOnly);
        await expectHighlighted(page, options.nth(0));
        await expectWithinScreen(page, paletteDialog(page));
        await expectNoSidewaysScroll(page);
        await scan();

        await page.keyboard.press("Enter");
        await reaches("/by-slug");
      });

      await test.step("finds a bookmark by a typo in its title and opens it", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, typoQuery);
        const first = bookmarkOptions().first();
        await expect(first).toContainText(typoWord);
        await expectHighlighted(page, first);
        await scan();

        await page.keyboard.press("Enter");
        await reaches("/by-typo");
      });

      await test.step("opens a bookmark in a new tab with Ctrl (Command) and Enter, and leaves this one where it was", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, slugWord);
        await expect(bookmarkOptions().nth(0)).toContainText(slugTitle);
        await expectHighlighted(page, bookmarkOptions().nth(0));

        const opened = context.waitForEvent("page");
        await page.keyboard.press("ControlOrMeta+Enter");
        const tab = await opened;
        try {
          await expect(tab).toHaveURL(target.url("/by-slug"));
          await expect(tab.getByRole("heading", { level: 1, name: DESTINATION_HEADING })).toBeVisible();
        } finally {
          await tab.close();
        }
        await expect(paletteDialog(page)).toHaveCount(0);
        await expect(listHeading(page)).toBeVisible();
        expect(new URL(page.url()).pathname, "the page the palette was opened on").toBe("/bookmarks");
      });

      await test.step("edits a bookmark of the member with Alt and Enter", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, slugWord);
        await expect(bookmarkOptions().nth(0)).toContainText(slugTitle);
        await expectHighlighted(page, bookmarkOptions().nth(0));

        await page.keyboard.press("Alt+Enter");
        const editor = page.getByRole("dialog", { name: en("bookmarks.modal.edit.title"), exact: true });
        await expect(editor).toBeVisible();
        await expect(paletteDialog(page)).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`bookmark=${editedId}`));
        await expect(editor.getByLabel(en("bookmarks.modal.title.label"), { exact: true })).toHaveValue(slugTitle);
        await expectWithinScreen(page, editor);
        await scan();

        await page.keyboard.press("Escape");
        await expect(editor).toHaveCount(0);
      });

      await test.step("goes to a slug with `go` and forwards to the destination", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, `go ${goSlug}`);
        const dialog = paletteDialog(page);
        await expect(dialog.getByText(en("palette.go.mode"), { exact: true })).toBeVisible();
        // The row gains the bookmark's title and host once the suggestions answer, so its name is matched by its start.
        const row = dialog.getByRole("option", { name: new RegExp(`^${escapeRegExp(en("palette.go.open", { slug: goSlug }))}`) });
        await expect(row).toBeVisible();
        await expectHighlighted(page, row);
        await expectWithinScreen(page, dialog);
        await scan();

        await page.keyboard.press("Enter");
        await reaches("/via-go");
      });

      await test.step("shows the hint to create a bookmark for a slug nobody has, and the hint opens the bookmark form with the slug", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, `go ${missingSlug}`);
        const dialog = paletteDialog(page);
        await page.keyboard.press("Enter");
        await expect(dialog.getByRole("heading", { name: en("go.notFound.title", { slug: missingSlug, workspace: WORKSPACE_NAME }), exact: true })).toBeVisible();
        const create = dialog.getByRole("option", { name: en("go.notFound.create"), exact: true });
        await expect(create).toBeVisible();
        await expectHighlighted(page, create);
        await expectWithinScreen(page, dialog);
        await expectNoSidewaysScroll(page);
        await scan();

        await page.keyboard.press("Enter");
        const form = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
        await expect(form).toBeVisible();
        await expect(dialog).toHaveCount(0);
        await expect(form.getByLabel(en("bookmarks.modal.slug.label"), { exact: true })).toHaveValue(missingSlug);
        await expectWithinScreen(page, form);
        await scan();
        expect(target.requests(), "the destination was not asked for the slug nobody has").not.toContain(`/${missingSlug}`);
      });

      await test.step("lists a bookmark titled with markup as text and runs nothing", async () => {
        await startOnList();
        await openPaletteWithShortcut(page);
        await type(page, hostileWord);
        const option = bookmarkOptions().filter({ hasText: hostileWord });
        await expect(option).toHaveCount(1);
        const label = option.getByText(hostileTitle, { exact: true });
        await expect(label).toBeVisible();
        // The payload would have made an image with a handler; the title is a text node and nothing else came from it.
        expect(await label.evaluate((node) => node.children.length)).toBe(0);
        await expect(paletteDialog(page).locator("img, script, iframe, [onerror], [onload]")).toHaveCount(0);
        await expectNoSidewaysScroll(page);
        await scan();
        expect(dialogs, "scripts that ran while the palette listed the title").toEqual([]);

        await page.keyboard.press("Escape");
        await expect(paletteDialog(page)).toHaveCount(0);
      });

      expect(dialogs, "scripts that ran during the journey").toEqual([]);
    });
  });
}
