import { randomBytes } from "node:crypto";
import type { Dialog, Locator, Page, Request, Response } from "@playwright/test";
import { bookmarkBody, bookmarkShape } from "../support/bookmark-fixtures.ts";
import { message } from "../support/catalog.ts";
import { appOrigin } from "../support/environment.ts";
import { expect, test } from "../support/test.ts";

// The bookmarks journey (doc 08 section 5.1, doc 03 sections 3 and 4, doc 10 T14, doc 12 Phase 3), after the first-run
// setup (tests/first-run.setup.ts): a bookmark whose title is an `onerror` payload is stored through the API and opened in
// the list, where the title shows verbatim and no handler runs; the member creates a bookmark through the modal, edits it
// against its version (If-Match), pins it, makes and handles a third from the keyboard alone, and then selects every
// pinned bookmark with "select all matching" and deletes them in bulk. Each page and overlay it reaches is scanned
// for WCAG 2.2 AA violations (tests/axe.spec.ts, support/axe.ts). The journey runs on a desktop screen in each engine and on a 390 px wide
// phone in Chromium (Q39); on both the page has no horizontal scroll and the dialogs fit the screen, and on the desktop screen the list keeps its gutter in both views at 1280 and 1440 px. Every text is read from the catalogs of packages/web.
//
// The journey acts on the pinned bookmarks of the one workspace of the stack, so it takes the lock of the account's
// preferences for as long as it runs (the `account` fixture), which keeps the other journeys, the other engines and
// the other screen size away from it, and removes what it made, also when a step fails. The title of each bookmark carries a
// token made up for this run.

const PHONE = { width: 390, height: 844 };

const BOOKMARKS = "/api/v1/bookmarks";

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

function listHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("bookmarks.page.title") });
}

/** The card of a bookmark of the grid, found by its title. */
function card(page: Page, title: string): Locator {
  return page.locator("[data-item-id]").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

function modal(page: Page, name: "bookmarks.modal.create.title" | "bookmarks.modal.edit.title"): Locator {
  return page.getByRole("dialog", { name: en(name), exact: true });
}

function isCreate(response: Response): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname === BOOKMARKS;
}

function isBulk(request: Request): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === `${BOOKMARKS}/bulk`;
}

function updatesBookmark(id: string): (request: Request) => boolean {
  return (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `${BOOKMARKS}/${id}`;
}

/**
 * Opens the actions of a card and chooses one. On a desktop the actions are the items of a menu; on a phone they are the
 * buttons of a sheet that has the same name.
 */
async function chooseAction(page: Page, title: string, action: string): Promise<void> {
  const label = en("bookmarks.list.actionsFor", { title });
  await page.getByRole("button", { name: label, exact: true }).click();
  const item = page.getByRole("menuitem", { name: action, exact: true }).or(page.getByRole("dialog", { name: label, exact: true }).getByRole("button", { name: action, exact: true }));
  await item.click();
  // The menu or the sheet has closed, so what follows starts from the page and not from a list that is still closing.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: label, exact: true })).toHaveCount(0);
}

/** The page is not wider than the screen, so there is nothing to scroll sideways to (Q39). */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const wide = await page.evaluate(() =>
    Array.from(document.body.querySelectorAll("*"))
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1 && !element.closest("[inert], [aria-hidden='true']"))
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").slice(0, 60)} ends at ${String(Math.round(element.getBoundingClientRect().right))}`),
  );
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `the page is wider than the screen by this many pixels; elements beyond its edge: ${wide.join("; ")}`).toBeLessThanOrEqual(0);
}

/** The list keeps a gutter between its content and both edges of the main area. */
async function expectGutter(page: Page): Promise<void> {
  const main = await page.locator("main").boundingBox();
  const heading = await listHeading(page).boundingBox();
  const last = await page.locator("[data-slot='load-more']").boundingBox();
  expect(main, "the main area has a box").not.toBeNull();
  expect(heading, "the heading has a box").not.toBeNull();
  expect(last, "the load-more row has a box").not.toBeNull();
  if (main !== null && heading !== null && last !== null) {
    expect(heading.x - main.x, "the gutter before the heading").toBeGreaterThanOrEqual(16);
    expect(main.x + main.width - (last.x + last.width), "the gutter after the load-more row").toBeGreaterThanOrEqual(16);
  }
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

/** Presses Tab until the element has focus; the keyboard is the only input that moves it. */
async function tabTo(page: Page, target: Locator, presses = 20): Promise<void> {
  for (let press = 0; press < presses; press++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target, `Tab reaches the element within ${String(presses)} presses`).toBeFocused({ timeout: 1000 });
}

/**
 * Moves the focus to a card with `J` (down) and `K` (up). The first press puts the focus on the card the list resumes
 * at, the one focus was last in, so which key comes next depends on where that is.
 */
async function moveFocusTo(page: Page, target: Locator, presses = 8): Promise<void> {
  for (let press = 0; press < presses; press++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    const position = await target.evaluate((element) => {
      const cards = Array.from(document.querySelectorAll("[data-item-id]"));
      const focused = cards.findIndex((card) => card === document.activeElement);
      return { target: cards.indexOf(element), focused };
    });
    await page.keyboard.press(position.focused === -1 || position.target > position.focused ? "j" : "k");
  }
  await expect(target, `J and K reach the card within ${String(presses)} presses`).toBeFocused({ timeout: 1000 });
}

for (const { name, viewport } of [
  { name: "on a desktop screen", viewport: undefined },
  { name: "on a 390 px wide phone", viewport: PHONE },
] as const) {
  test.describe(`bookmarks journey ${name}`, () => {
    if (viewport !== undefined) {
      test.use({ viewport });
      // Every run holds the lock of the account's preferences until it ends and the others wait for it, so the run at
      // phone size, which takes the longest, is one engine's.
      test.skip(({ browserName }) => browserName !== "chromium", "the phone-size run is Chromium's");
    }

    const fits = async (page: Page): Promise<void> => {
      await expectNoSidewaysScroll(page);
    };

    test("stores hostile text and shows it as text, then creates, edits, pins and deletes bookmarks", async ({ page, app, account }) => {
      test.setTimeout(150_000);
      await account.set({ locale: "en" });

      // A toast of an earlier step is not part of the page or the dialog under test, and the ones stacked behind the
      // frontmost have a darkened background of their own, so each scan waits for them to go. A toast does not go while
      // the pointer rests on its stack, and on a phone the sheets and modals end the clicks of the journey in the band
      // the toasts rise in, so the pointer is moved off to the corner first.
      const scan = async (): Promise<void> => {
        await page.mouse.move(0, 0);
        await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
        await app.scan();
      };

      const token = randomBytes(4).toString("hex");
      const ids = new Set<string>();
      const dialogs: string[] = [];
      page.on("dialog", (dialog: Dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      // Every bookmark this page creates is removed at the end, deleted by the journey or not.
      page.on("response", (response) => {
        if (isCreate(response) && response.status() === 201) {
          void response.json().then((body: { id?: unknown }) => {
            if (typeof body.id === "string") {
              ids.add(body.id);
            }
          });
        }
      });

      let finished = false;
      try {
        // A title that is a stranger's markup, stored through the API: a pinned bookmark, so that the pinned
        // filter of the last step holds all three of the bookmarks the journey makes.
        const shape = bookmarkShape("markup-title");
        const hostileTitle = `${shape.title} ${token}`;
        const stored = await page.request.post(BOOKMARKS, {
          headers: { origin: appOrigin() },
          data: { ...bookmarkBody(shape), title: hostileTitle, pinned: true },
        });
        expect(stored.status(), "POST /api/v1/bookmarks of the hostile bookmark").toBe(201);
        const storedBody = (await stored.json()) as { id: string };
        ids.add(storedBody.id);

        await test.step("opens the list, where the hostile title shows verbatim and runs nothing", async () => {
          await app.visit("/bookmarks", listHeading(page));
          const hostile = card(page, hostileTitle);
          await expect(hostile).toBeVisible();
          await expect(hostile.getByText(hostileTitle, { exact: true })).toBeVisible();
          // The payload would have made an image with a handler; the text is a text node of the card and nothing else came from it.
          await expect(page.locator("main img, main script, main iframe, main [onerror], main [onload]")).toHaveCount(0);
          await expect(hostile.getByRole("img", { name: en("bookmarks.list.pinned") })).toBeVisible();
          expect(await hostile.getByText(hostileTitle, { exact: true }).evaluate((node) => node.children.length)).toBe(0);
          await fits(page);
          expect(dialogs, "scripts that ran while the list loaded").toEqual([]);
        });

        if (viewport === undefined) {
          // The list, down to the load-more row, ends within the page and keeps its gutter in both views, at the width of
          // the project's desktop screen and at a wider one.
          await test.step("keeps the list within the page in both views at desktop widths", async () => {
            const size = page.viewportSize();
            expect(size, "the page has a viewport").not.toBeNull();
            const loadMore = page.locator("[data-slot='load-more']");
            const fitsAtDesktopWidths = async (): Promise<void> => {
              await expect(loadMore).toBeVisible();
              for (const width of [size?.width ?? 1280, 1440]) {
                await page.setViewportSize({ width, height: size?.height ?? 720 });
                await fits(page);
                await expectGutter(page);
              }
              if (size !== null) {
                await page.setViewportSize(size);
              }
            };
            await fitsAtDesktopWidths();
            // The view comes from the address: choosing it in the toolbar would also change the account's default view.
            await app.visit("/bookmarks?view=table", listHeading(page));
            await expect(page.locator("[data-slot='data-table']")).toBeVisible();
            await fitsAtDesktopWidths();
            // The next steps start from the plain address, whose view is the account's default.
            await page.goto("/bookmarks");
            await expect(listHeading(page)).toBeVisible();
            await expect(page.locator("[data-slot='card-grid']")).toBeVisible();
          });
        }

        const createdTitle = `Journey ${token}`;
        const createdUrl = `https://example.com/journey-${token}`;
        let createdId = "";
        let createdVersion = 0;

        await test.step("creates a bookmark through the modal", async () => {
          await page.getByRole("button", { name: en("bookmarks.new"), exact: true }).click();
          const dialog = modal(page, "bookmarks.modal.create.title");
          await expect(dialog).toBeVisible();
          await expect(page).toHaveURL(/\?new=1$/);
          await dialog.getByLabel(en("bookmarks.modal.url.label"), { exact: true }).fill(createdUrl);
          await dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true }).fill(createdTitle);
          await expectWithinScreen(page, dialog);
          await fits(page);
          await scan();

          const created = page.waitForResponse(isCreate);
          await dialog.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }).click();
          const response = await created;
          expect(response.status(), "POST /api/v1/bookmarks").toBe(201);
          const body = (await response.json()) as { id: string; version: number; title: string; pinned: boolean };
          expect(body.title).toBe(createdTitle);
          expect(body.pinned).toBe(false);
          createdId = body.id;
          createdVersion = body.version;
          ids.add(createdId);

          await expect(dialog).toHaveCount(0);
          await expect(card(page, createdTitle)).toBeVisible();
        });

        const editedTitle = `Journey edited ${token}`;

        await test.step("edits it against the version it loaded", async () => {
          await chooseAction(page, createdTitle, en("bookmarks.list.edit"));
          const dialog = modal(page, "bookmarks.modal.edit.title");
          await expect(dialog).toBeVisible();
          await expect(page).toHaveURL(new RegExp(`\\?bookmark=${createdId}$`));
          const title = dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true });
          await expect(title).toHaveValue(createdTitle);
          await title.fill(editedTitle);
          await expectWithinScreen(page, dialog);
          await scan();

          const sent = page.waitForRequest(updatesBookmark(createdId));
          await dialog.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }).click();
          const request = await sent;
          expect(request.headers()["if-match"], "the version the edit was made against").toBe(`"${String(createdVersion)}"`);
          const response = await request.response();
          expect(response?.status(), "PATCH /api/v1/bookmarks/{id}").toBe(200);
          expect(((await response?.json()) as { title?: unknown } | undefined)?.title).toBe(editedTitle);

          await expect(dialog).toHaveCount(0);
          await expect(card(page, editedTitle)).toBeVisible();
          await expect(card(page, createdTitle)).toHaveCount(0);
        });

        await test.step("pins it", async () => {
          const edited = card(page, editedTitle);
          await expect(edited.getByRole("img", { name: en("bookmarks.list.pinned") })).toHaveCount(0);
          const sent = page.waitForRequest(updatesBookmark(createdId));
          await chooseAction(page, editedTitle, en("bookmarks.list.pin.action"));
          const request = await sent;
          expect(request.headers()["if-match"], "the pin is made against the version the list loaded").toBe(`"${String(createdVersion + 1)}"`);
          const response = await request.response();
          expect(response?.status(), "PATCH /api/v1/bookmarks/{id} of the pin").toBe(200);
          expect(((await response?.json()) as { pinned?: unknown } | undefined)?.pinned).toBe(true);
          await expect(edited.getByRole("img", { name: en("bookmarks.list.pinned") })).toBeVisible();
        });

        const keyboardTitle = `Keyboard ${token}`;

        await test.step("makes a bookmark and moves through the list with the keyboard alone", async () => {
          // `C` opens the modal and Esc closes it again.
          await page.keyboard.press("c");
          const create = modal(page, "bookmarks.modal.create.title");
          await expect(create).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(create).toHaveCount(0);
          await expect(page).not.toHaveURL(/new=1/);

          await page.keyboard.press("c");
          await expect(create).toBeVisible();
          await tabTo(page, create.getByLabel(en("bookmarks.modal.url.label"), { exact: true }));
          await page.keyboard.type(`https://example.com/keyboard-${token}`);
          await tabTo(page, create.getByLabel(en("bookmarks.modal.title.label"), { exact: true }));
          await page.keyboard.type(keyboardTitle);
          await tabTo(page, create.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }));
          await page.keyboard.press("Enter");
          await expect(create).toHaveCount(0);
          await expect(page).not.toHaveURL(/new=1/);
          const keyboardCard = card(page, keyboardTitle);
          await expect(keyboardCard).toBeVisible();

          // `J` and `K` move from card to card, `P` pins the focused one and `X` selects it.
          const hostile = card(page, hostileTitle);
          await moveFocusTo(page, keyboardCard);
          await page.keyboard.press("p");
          await expect(keyboardCard.getByRole("img", { name: en("bookmarks.list.pinned") })).toBeVisible();
          await page.keyboard.press("x");
          await expect(page.getByRole("checkbox", { name: en("bookmarks.list.select", { title: keyboardTitle }), exact: true })).toBeChecked();
          await page.keyboard.press("x");
          await expect(page.getByRole("toolbar", { name: en("bookmarks.bulk.label") })).toHaveCount(0);

          // `E` edits the focused card: the hostile bookmark's fields hold its text as typed, and Esc closes the modal.
          await moveFocusTo(page, hostile);
          await page.keyboard.press("e");
          const edit = modal(page, "bookmarks.modal.edit.title");
          await expect(edit).toBeVisible();
          await expect(edit.getByLabel(en("bookmarks.modal.title.label"), { exact: true })).toHaveValue(hostileTitle);
          await expect(edit.getByLabel(en("bookmarks.modal.description.label"), { exact: true })).toHaveValue(shape.description ?? "");
          await expect(edit.locator("img, script, iframe, [onerror], [onload]")).toHaveCount(0);
          await expectWithinScreen(page, edit);
          await scan();
          await page.keyboard.press("Escape");
          await expect(edit).toHaveCount(0);
          await expect(hostile).toBeVisible();
        });

        await test.step("selects every matching bookmark and deletes them in bulk", async () => {
          await page.getByRole("button", { name: en("bookmarks.list.filter.pinned"), exact: true }).click();
          await expect(page).toHaveURL(/\?pinned=true$/);
          await expect(page.locator("[data-item-id]")).toHaveCount(ids.size);
          await scan();

          await page.getByRole("checkbox", { name: en("bookmarks.list.select", { title: editedTitle }), exact: true }).check();
          const bar = page.getByRole("toolbar", { name: en("bookmarks.bulk.label") });
          await expect(bar.getByText(en("bookmarks.bulk.count", { count: "1" }), { exact: true })).toBeVisible();
          await bar.getByRole("button", { name: en("bookmarks.bulk.selectAll.all", { total: String(ids.size) }), exact: true }).click();
          await expect(bar.getByText(en("bookmarks.bulk.count", { count: String(ids.size) }), { exact: true })).toBeVisible();
          await fits(page);
          await scan();

          await bar.getByRole("button", { name: en("bookmarks.bulk.delete.action"), exact: true }).click();
          const confirm = page.getByRole("alertdialog", { name: en("bookmarks.bulk.delete.title", { count: String(ids.size) }), exact: true });
          await expect(confirm).toBeVisible();
          await expectWithinScreen(page, confirm);
          await scan();

          const sent = page.waitForRequest(isBulk);
          await confirm.getByRole("button", { name: en("bookmarks.bulk.delete.confirm", { count: String(ids.size) }), exact: true }).click();
          const request = await sent;
          expect((await request.response())?.status(), "POST /api/v1/bookmarks/bulk").toBe(200);
          // Not only the bookmark that was selected by hand: every pinned bookmark is gone.
          for (const id of ids) {
            expect((await page.request.get(`${BOOKMARKS}/${id}`)).status(), `GET /api/v1/bookmarks/${id} after the bulk delete`).toBe(404);
          }

          await expect(page.getByText(en("bookmarks.list.noMatch"), { exact: true })).toBeVisible();
          await expect(page.locator("[data-item-id]")).toHaveCount(0);
          await expect(page.getByRole("toolbar", { name: en("bookmarks.bulk.label") })).toHaveCount(0);
          await scan();
        });

        expect(dialogs, "scripts that ran during the journey").toEqual([]);
        finished = true;
      } finally {
        const refused: number[] = [];
        for (const id of ids) {
          // A mutation must come from the app's origin and be JSON, with or without a body.
          const removed = await page.request.delete(`${BOOKMARKS}/${id}`, { headers: { origin: appOrigin(), "content-type": "application/json" } });
          if (removed.status() !== 204 && removed.status() !== 404) {
            refused.push(removed.status());
          }
        }
        // A step that failed is the failure to report; the clean-up speaks only when the journey itself passed.
        if (finished && refused.length > 0) {
          throw new Error(`DELETE /api/v1/bookmarks/{id} answered ${refused.join(", ")} while the journey removed what it made`);
        }
      }
    });
  });
}
