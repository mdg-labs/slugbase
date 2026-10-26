import { randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse, Dialog, Locator, Page } from "@playwright/test";
import { findViolations, loadAllowlist } from "../support/axe.ts";
import { bookmarkBody, bookmarkShape } from "../support/bookmark-fixtures.ts";
import { message } from "../support/catalog.ts";
import { appOrigin } from "../support/environment.ts";
import { tabTo, waitForInitialFocus } from "../support/keyboard.ts";
import { expect, test } from "../support/test.ts";

// The folders and tags journey (doc 08 section 5.1, doc 03 sections 3, 4, 6 and 7, doc 02 section 7, doc 10 T14 and T2),
// after the first-run setup (tests/first-run.setup.ts): a folder and a tag whose names are `onerror` payloads are stored
// through the API and listed on the Folders page, the Tags page and in the sidebar, where each name shows verbatim and no
// handler runs; the member makes a folder and two tags inline in the bookmark modal, filters the list by the folder and by the
// two tags, renames one tag into another's name and confirms the merge, adds a tag to a selection from the bulk bar, and
// deletes the folder while its bookmarks stay. A second member of the same workspace, invited and signed in during the
// journey, sees none of the first member's tags in the Tags page or in the API, and cannot change one. The folder dialogs
// are opened, filled, saved and closed from the keyboard alone. Each page and overlay it reaches is scanned for WCAG 2.2 AA
// violations (tests/axe.spec.ts, support/axe.ts). Every text is read from the catalogs of packages/web.
//
// The journey acts on the one workspace of the stack and reads the language of the account, so it takes the lock of the
// account's preferences for as long as it runs (the `account` fixture), and it removes what it made, also when a step fails:
// its bookmarks, folders and tags, and the second member. Every name carries a token made up for this run. It runs in
// Chromium alone: the second member's session and the lock make it a long journey.

const API = { bookmarks: "/api/v1/bookmarks", folders: "/api/v1/folders", tags: "/api/v1/tags", invitations: "/api/v1/invitations", members: "/api/v1/members" } as const;

const NO_SESSION = { cookies: [], origins: [] };

const HOSTILE_NAME = "<img src=x onerror=alert(1)>";

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

interface Folder {
  id: string;
  name: string;
  bookmarkCount: number;
}

interface Tag {
  id: string;
  name: string;
  bookmarkCount: number;
}

interface Bookmark {
  id: string;
  title: string;
  folders: { id: string; name: string }[];
  tags: { id: string; name: string }[];
}

interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** A mutation must come from the app's origin and be JSON, with or without a body. */
const MUTATION = { origin: appOrigin(), "content-type": "application/json" };

async function json<T>(response: APIResponse, what: string, status: number): Promise<T> {
  expect(response.status(), what).toBe(status);
  return (await response.json()) as T;
}

/** Every item of a list the API pages through (at most 100 a page). */
async function listAll<T>(request: APIRequestContext, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "limit=100" : `limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page: Paged<T> = await json<Paged<T>>(await request.get(`${path}?${query}`), `GET ${path}`, 200);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

function listHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("bookmarks.page.title") });
}

function foldersHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("folders.page.title") });
}

function tagsHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("tags.page.title") });
}

/** The card of a bookmark of the grid, found by its title. */
function card(page: Page, title: string): Locator {
  return page.locator("[data-item-id]").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

/** The row of a table, found by the name it shows. */
function row(page: Page, tableName: string, name: string): Locator {
  return page.getByRole("table", { name: tableName, exact: true }).getByRole("row").filter({ hasText: name });
}

/** Opens the actions of a row of the Folders or Tags page and chooses one. */
async function chooseRowAction(page: Page, label: string, action: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** Presses the down arrow until the item of a menu has focus. */
async function arrowTo(page: Page, target: Locator, presses = 8): Promise<void> {
  for (let press = 0; press < presses; press++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("ArrowDown");
  }
  await expect(target, `the down arrow reaches the item within ${String(presses)} presses`).toBeFocused({ timeout: 1000 });
}

/** The field of a bookmark filter or of a dialog that picks from a list: opens the list and chooses one entry. */
async function pick(field: Locator, entry: Locator): Promise<void> {
  await field.click();
  await entry.click();
}

test.describe("folders and tags journey", () => {
  // A click that finds its target covered waits for the test to time out unless the actions are bounded.
  test.use({ actionTimeout: 15_000 });
  test.skip(({ browserName }) => browserName !== "chromium", "the journey is Chromium's: it holds the lock of the account's preferences and a second member's session");

  test("makes folders and tags inline, filters, merges, bulk-tags and deletes a folder, and a second member sees none of the tags", async ({
    page,
    app,
    account,
    browser,
  }) => {
    test.setTimeout(300_000);
    await account.set({ locale: "en" });

    // A toast of an earlier step is not part of the page or the dialog under test, and the ones stacked behind the
    // frontmost have a darkened background of their own, so each scan waits for them to go. A toast does not go while
    // the pointer rests on its stack, so the pointer is moved off first.
    const scan = async (): Promise<void> => {
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
      await app.scan();
    };

    const token = randomBytes(4).toString("hex");
    const names = {
      hostileFolder: `${HOSTILE_NAME} ${token}`,
      hostileTag: `${HOSTILE_NAME} ${token}`,
      folder: `Journey folder ${token}`,
      keyboardFolder: `Keyboard folder ${token}`,
      renamedFolder: `Keyboard renamed ${token}`,
      alpha: `alpha-${token}`,
      beta: `beta-${token}`,
      gamma: `gamma-${token}`,
      delta: `delta-${token}`,
    };
    const titles = {
      a: `Journey A ${token}`,
      b: `Journey B ${token}`,
      c: `Journey C ${token}`,
      d: `Journey D ${token}`,
    };
    const dialogs: string[] = [];
    page.on("dialog", (dialog: Dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    const request = page.request;
    // What the journey made, found again by its token when it ends: the folders and tags by name, the bookmarks by title.
    const made = { memberAccountId: undefined as string | undefined, bookmarkIds: new Set<string>() };

    const createBookmark = async (body: Record<string, unknown>, what: string): Promise<Bookmark> => {
      const created = await json<Bookmark>(await request.post(API.bookmarks, { headers: MUTATION, data: body }), what, 201);
      made.bookmarkIds.add(created.id);
      return created;
    };
    const tagNamed = async (name: string): Promise<Tag | undefined> => (await listAll<Tag>(request, API.tags)).find((tag) => tag.name === name);
    const bookmarkOf = async (id: string): Promise<Bookmark> => json<Bookmark>(await request.get(`${API.bookmarks}/${id}`), `GET ${API.bookmarks}/${id}`, 200);

    let finished = false;
    try {
      await test.step("lists a folder and a tag named with markup as text and runs nothing", async () => {
        const hostileFolder = await json<Folder>(await request.post(API.folders, { headers: MUTATION, data: { name: names.hostileFolder } }), "POST /api/v1/folders of the hostile folder", 201);
        const hostileTag = await json<Tag>(await request.post(API.tags, { headers: MUTATION, data: { name: names.hostileTag } }), "POST /api/v1/tags of the hostile tag", 201);
        try {
          await app.visit("/folders", foldersHeading(page));
          const folderRow = row(page, en("folders.list.label"), names.hostileFolder);
          await expect(folderRow.getByText(names.hostileFolder, { exact: true })).toBeVisible();
          expect(await folderRow.getByText(names.hostileFolder, { exact: true }).evaluate((node) => node.children.length)).toBe(0);
          await expect(page.getByRole("navigation", { name: en("shell.navigation") }).getByRole("link", { name: names.hostileFolder, exact: true })).toBeVisible();
          // The payload would have made an image with a handler; the name is a text node and nothing came from it.
          await expect(page.locator("main img, main script, main iframe, main [onerror], main [onload]")).toHaveCount(0);

          await app.visit("/tags", tagsHeading(page));
          const tagRow = row(page, en("tags.list.label"), names.hostileTag);
          await expect(tagRow.getByText(names.hostileTag, { exact: true })).toBeVisible();
          expect(await tagRow.getByText(names.hostileTag, { exact: true }).evaluate((node) => node.children.length)).toBe(0);
          await expect(page.locator("main img, main script, main iframe, main [onerror], main [onload]")).toHaveCount(0);
          expect(dialogs, "scripts that ran while the folders and tags were listed").toEqual([]);
        } finally {
          const gone = [
            (await request.delete(`${API.folders}/${hostileFolder.id}`, { headers: MUTATION })).status(),
            (await request.delete(`${API.tags}/${hostileTag.id}`, { headers: MUTATION })).status(),
          ];
          if (finished || gone.some((status) => status !== 204)) {
            expect(gone, "DELETE of the hostile folder and tag").toEqual([204, 204]);
          }
        }
      });

      let folderId = "";
      const bookmarkA = { id: "" };

      await test.step("makes a folder and two tags inline in the bookmark modal", async () => {
        await app.visit("/bookmarks", listHeading(page));
        // An empty list has a button of its own beside the one of the header.
        await page.getByRole("banner").getByRole("button", { name: en("bookmarks.new"), exact: true }).click();
        const dialog = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel(en("bookmarks.modal.url.label"), { exact: true }).fill(`https://example.com/journey-a-${token}`);
        await dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true }).fill(titles.a);

        const chips = dialog.locator("[data-slot='multi-pick-chip']");
        const folderField = dialog.getByRole("combobox", { name: en("bookmarks.modal.folders.label"), exact: true });
        const madeFolder = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === API.folders);
        await folderField.fill(names.folder);
        await page.getByRole("option", { name: en("bookmarks.modal.folders.create", { name: names.folder }), exact: true }).click();
        const folderResponse = await madeFolder;
        expect(folderResponse.status(), "POST /api/v1/folders from the modal").toBe(201);
        folderId = ((await folderResponse.json()) as Folder).id;
        await expect(chips.filter({ hasText: names.folder })).toBeVisible();

        const tagField = dialog.getByRole("combobox", { name: en("bookmarks.modal.tags.label"), exact: true });
        for (const name of [names.alpha, names.beta]) {
          await tagField.fill(name);
          await page.getByRole("option", { name: en("bookmarks.modal.tags.create", { name }), exact: true }).click();
          await expect(chips.filter({ hasText: name })).toBeVisible();
        }
        // The list of a field closes before the dialog is scanned, so the scan sees the dialog and not a popup over it.
        await dialog.getByRole("heading", { name: en("bookmarks.modal.create.title"), exact: true }).click();
        await expect(page.locator("[data-slot='multi-pick-popup']")).toHaveCount(0);
        await scan();

        const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === API.bookmarks);
        await dialog.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }).click();
        const response = await created;
        expect(response.status(), "POST /api/v1/bookmarks").toBe(201);
        const body = (await response.json()) as Bookmark;
        made.bookmarkIds.add(body.id);
        bookmarkA.id = body.id;
        expect(body.folders.map((folder) => folder.name)).toEqual([names.folder]);
        expect(body.tags.map((tag) => tag.name).sort()).toEqual([names.alpha, names.beta]);
        await expect(dialog).toHaveCount(0);
        await expect(card(page, titles.a)).toBeVisible();
      });

      const alpha = await tagNamed(names.alpha);
      const beta = await tagNamed(names.beta);
      expect(alpha, "the tag the modal made").toBeDefined();
      expect(beta, "the tag the modal made").toBeDefined();
      if (alpha === undefined || beta === undefined) {
        throw new Error("the tags the modal made are not listed");
      }

      // B is in the folder with one of the tags, C has both tags and no folder, D has a tag of its own that the merge
      // will receive; delta is the tag the bulk bar adds.
      const shape = bookmarkShape("markup-title");
      const bookmarkB = await createBookmark({ ...bookmarkBody(shape), url: `https://example.com/journey-b-${token}`, title: titles.b, folderIds: [folderId], tagIds: [alpha.id] }, "POST /api/v1/bookmarks of B");
      const bookmarkC = await createBookmark({ ...bookmarkBody(shape), url: `https://example.com/journey-c-${token}`, title: titles.c, tagIds: [alpha.id, beta.id] }, "POST /api/v1/bookmarks of C");
      const bookmarkD = await createBookmark({ ...bookmarkBody(shape), url: `https://example.com/journey-d-${token}`, title: titles.d, tagNames: [names.gamma] }, "POST /api/v1/bookmarks of D");
      await json<Tag>(await request.post(API.tags, { headers: MUTATION, data: { name: names.delta } }), "POST /api/v1/tags of delta", 201);

      await test.step("filters the list by the folder and by two tags", async () => {
        await app.visit("/bookmarks", listHeading(page));
        for (const title of Object.values(titles)) {
          await expect(card(page, title)).toBeVisible();
        }

        const folderField = page.getByRole("combobox", { name: en("bookmarks.list.filters.folder.label"), exact: true });
        const chips = page.getByRole("list", { name: en("bookmarks.list.filters.active"), exact: true });
        await pick(folderField, page.getByRole("option", { name: names.folder, exact: true }));
        await expect(page).toHaveURL(new RegExp(`folderId=${folderId}`));
        await expect(chips.getByText(en("bookmarks.list.filters.folderChip", { name: names.folder }), { exact: true })).toBeVisible();
        await expect(card(page, titles.a)).toBeVisible();
        await expect(card(page, titles.b)).toBeVisible();
        await expect(card(page, titles.c)).toHaveCount(0);
        await expect(card(page, titles.d)).toHaveCount(0);
        await scan();

        await chips.getByRole("button", { name: en("bookmarks.list.filters.remove", { label: en("bookmarks.list.filters.folderChip", { name: names.folder }) }), exact: true }).click();
        await expect(page).not.toHaveURL(/folderId=/);
        await expect(card(page, titles.d)).toBeVisible();

        const tagField = page.getByRole("combobox", { name: en("bookmarks.list.filters.tags.label"), exact: true });
        await pick(tagField, page.getByRole("option", { name: names.alpha, exact: true }));
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-slot='multi-pick-popup']")).toHaveCount(0);
        await expect(card(page, titles.a)).toBeVisible();
        await expect(card(page, titles.b)).toBeVisible();
        await expect(card(page, titles.c)).toBeVisible();
        await expect(card(page, titles.d)).toHaveCount(0);
        await scan();

        await pick(tagField, page.getByRole("option", { name: names.beta, exact: true }));
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-slot='multi-pick-popup']")).toHaveCount(0);
        // A bookmark must carry both tags: B has only the first.
        await expect(card(page, titles.a)).toBeVisible();
        await expect(card(page, titles.c)).toBeVisible();
        await expect(card(page, titles.b)).toHaveCount(0);
        await expect(card(page, titles.d)).toHaveCount(0);
        await scan();

        // The folder narrows the two tags further: only A is in the folder.
        await pick(folderField, page.getByRole("option", { name: names.folder, exact: true }));
        await expect(card(page, titles.a)).toBeVisible();
        await expect(card(page, titles.c)).toHaveCount(0);
        await scan();

        await page.getByRole("button", { name: en("bookmarks.list.clearFilters"), exact: true }).click();
        await expect(page).toHaveURL(/\/bookmarks$/);
        await expect(card(page, titles.d)).toBeVisible();
      });

      await test.step("renames a tag into the name of another and merges the two", async () => {
        const gamma = await tagNamed(names.gamma);
        expect(gamma, "the tag the bookmark D made").toBeDefined();
        await app.visit("/tags", tagsHeading(page));
        await chooseRowAction(page, en("tags.list.actionsFor", { name: names.beta }), en("tags.actions.rename"));
        const form = page.getByRole("dialog", { name: en("tags.form.title"), exact: true });
        await expect(form).toBeVisible();
        await form.getByLabel(en("tags.form.name.label"), { exact: true }).fill(names.gamma);
        await scan();

        await form.getByRole("button", { name: en("tags.form.submit"), exact: true }).click();
        const confirm = page.getByRole("alertdialog", { name: en("tags.merge.title", { into: names.gamma }), exact: true });
        await expect(confirm).toBeVisible();
        await expect(confirm.getByText(en("tags.merge.description", { count: "2", from: names.beta, into: names.gamma }), { exact: true })).toBeVisible();
        await scan();

        const merged = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${API.tags}/${beta.id}/merge`);
        await confirm.getByRole("button", { name: en("tags.merge.confirm"), exact: true }).click();
        expect((await merged).status(), "POST /api/v1/tags/{id}/merge").toBe(200);
        await expect(confirm).toHaveCount(0);
        await expect(form).toHaveCount(0);
        await expect(row(page, en("tags.list.label"), names.beta)).toHaveCount(0);
        await expect(row(page, en("tags.list.label"), names.gamma).getByText(en("tags.list.bookmarkCount", { count: "3" }))).toBeVisible();
        await scan();

        // A and C carried the renamed tag; both carry the one it was merged into now, with D, and neither is left with two.
        expect(await tagNamed(names.beta), "the tag that was merged away").toBeUndefined();
        expect((await tagNamed(names.gamma))?.bookmarkCount).toBe(3);
        for (const id of [bookmarkA.id, bookmarkC.id]) {
          expect((await bookmarkOf(id)).tags.map((tag) => tag.name).sort()).toEqual([names.alpha, names.gamma]);
        }
        expect((await bookmarkOf(bookmarkD.id)).tags.map((tag) => tag.name)).toEqual([names.gamma]);
      });

      await test.step("adds a tag to a selection from the bulk bar", async () => {
        await app.visit("/bookmarks", listHeading(page));
        for (const title of [titles.a, titles.b]) {
          await page.getByRole("checkbox", { name: en("bookmarks.list.select", { title }), exact: true }).check();
        }
        const bar = page.getByRole("toolbar", { name: en("bookmarks.bulk.label") });
        await expect(bar.getByText(en("bookmarks.bulk.count", { count: "2" }), { exact: true })).toBeVisible();
        await bar.getByRole("button", { name: en("bookmarks.bulk.addTags"), exact: true }).click();

        const dialog = page.getByRole("dialog", { name: en("bookmarks.bulk.link.title.addTags", { count: "2" }), exact: true });
        await expect(dialog).toBeVisible();
        await pick(dialog.getByRole("combobox", { name: en("bookmarks.bulk.link.tags.label"), exact: true }), page.getByRole("option", { name: names.delta, exact: true }));
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-slot='multi-pick-popup']")).toHaveCount(0);
        const preview = dialog.getByRole("region", { name: en("bookmarks.bulk.link.preview.title"), exact: true });
        await expect(preview.getByText(en("bookmarks.bulk.link.preview.summary", { count: "2" }), { exact: true })).toBeVisible();
        await expect(preview.getByText(names.delta, { exact: true })).toBeVisible();
        await scan();

        const sent = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${API.bookmarks}/bulk`);
        await dialog.getByRole("button", { name: en("bookmarks.bulk.addTags"), exact: true }).click();
        expect((await sent).status(), "POST /api/v1/bookmarks/bulk").toBe(200);
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("[data-slot='toast-title']").filter({ hasText: en("bookmarks.bulk.done.addTags", { count: "2" }) })).toBeVisible();

        for (const id of [bookmarkA.id, bookmarkB.id]) {
          expect((await bookmarkOf(id)).tags.map((tag) => tag.name), `the tags of the selected bookmark ${id}`).toContain(names.delta);
        }
        for (const id of [bookmarkC.id, bookmarkD.id]) {
          expect((await bookmarkOf(id)).tags.map((tag) => tag.name), `the tags of the bookmark ${id}, which was not selected`).not.toContain(names.delta);
        }
      });

      await test.step("a second member of the workspace sees none of the first member's tags, in the UI or in the API", async () => {
        const owner = await json<{ account: { id: string } }>(await request.get("/api/v1/me"), "GET /api/v1/me", 200);
        const invitee = { email: `member-${token}@example.test`, name: "Second Member", password: randomBytes(24).toString("base64url") };
        const invitation = await json<{ id: string }>(
          await request.post(API.invitations, { headers: MUTATION, data: { email: invitee.email, role: "member" } }),
          "POST /api/v1/invitations",
          201,
        );
        // The link is the one the mail carries, taken from the API so that the journey does not depend on the mail relay.
        const issued = await json<{ link: string }>(await request.post(`${API.invitations}/${invitation.id}/link`, { headers: MUTATION }), "POST /api/v1/invitations/{id}/link", 200);
        const inviteToken = issued.link.split("/invite/")[1] ?? "";
        expect(inviteToken, "the token of the invitation link").not.toBe("");

        const context = await browser.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, locale: "en-US", storageState: NO_SESSION });
        try {
          const accepted = await json<{ workspaceId: string; role: string }>(
            await context.request.post("/api/v1/invitations/accept", { headers: MUTATION, data: { token: inviteToken, displayName: invitee.name, password: invitee.password } }),
            "POST /api/v1/invitations/accept",
            201,
          );
          expect(accepted.role).toBe("member");
          const member = await json<{ account: { id: string } }>(await context.request.get("/api/v1/me"), "GET /api/v1/me of the second member", 200);
          made.memberAccountId = member.account.id;
          expect(member.account.id).not.toBe(owner.account.id);

          // The API: the second member lists no tag of the first, and cannot rename or delete one by its identifier.
          const theirTags = await listAll<Tag>(context.request, API.tags);
          expect(theirTags.filter((tag) => tag.name.includes(token)), "the tags of the first member in the second member's list").toEqual([]);
          const theirFolders = await listAll<Folder>(context.request, API.folders);
          expect(theirFolders.filter((folder) => folder.name.includes(token)), "the folders of the first member in the second member's list").toEqual([]);
          expect((await context.request.patch(`${API.tags}/${alpha.id}`, { headers: MUTATION, data: { name: `taken-${token}` } })).status(), "PATCH /api/v1/tags/{id} of the first member's tag").toBe(404);
          expect((await context.request.delete(`${API.tags}/${alpha.id}`, { headers: MUTATION })).status(), "DELETE /api/v1/tags/{id} of the first member's tag").toBe(404);
          expect((await tagNamed(names.alpha))?.id, "the first member's tag is as it was").toBe(alpha.id);

          // The UI: the Tags page of the second member is empty, and so is the Folders section of the sidebar.
          const theirs = await context.newPage();
          try {
            await theirs.goto("/tags");
            await expect(tagsHeading(theirs)).toBeVisible();
            await expect(theirs.getByRole("heading", { level: 2, name: en("tags.list.empty.title"), exact: true })).toBeVisible();
            await expect(theirs.getByText(names.alpha)).toHaveCount(0);
            await expect(theirs.getByText(names.gamma)).toHaveCount(0);
            await expect(theirs.getByText(names.delta)).toHaveCount(0);
            expect(await findViolations(theirs, loadAllowlist()), "WCAG 2.2 AA violations on the second member's Tags page").toEqual([]);

            await theirs.goto("/bookmarks");
            await expect(listHeading(theirs)).toBeVisible();
            await expect(theirs.getByRole("navigation", { name: en("shell.navigation") }).getByText(en("shell.foldersSection.empty"), { exact: true })).toBeVisible();
            await expect(theirs.getByRole("link", { name: names.folder, exact: true })).toHaveCount(0);
            await expect(theirs.locator("[data-item-id]").filter({ hasText: token })).toHaveCount(0);
          } finally {
            await theirs.close();
          }
        } finally {
          await context.close();
        }
      });

      await test.step("opens, fills, saves and closes the folder dialogs from the keyboard alone", async () => {
        await app.visit("/folders", foldersHeading(page));

        // `N` opens the form and Esc closes it again.
        await page.keyboard.press("n");
        const create = page.getByRole("dialog", { name: en("folders.form.title.create"), exact: true });
        await expect(create).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(create).toHaveCount(0);

        await page.keyboard.press("n");
        await expect(create).toBeVisible();
        // The form moves the focus to the name field a moment after it shows; a Tab before that starts from the wrong place.
        const createName = create.getByLabel(en("folders.form.name.label"), { exact: true });
        await waitForInitialFocus(createName, "the name field of the New folder dialog");
        await tabTo(page, createName);
        await page.keyboard.type(names.keyboardFolder);
        await scan();
        await tabTo(page, create.getByRole("button", { name: en("folders.form.submit.create"), exact: true }));
        const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === API.folders);
        await page.keyboard.press("Enter");
        expect((await created).status(), "POST /api/v1/folders from the keyboard").toBe(201);
        await expect(create).toHaveCount(0);
        await expect(row(page, en("folders.list.label"), names.keyboardFolder)).toBeVisible();

        // The actions of a row are a menu: Enter opens it, the arrows move through it and Enter chooses.
        const actions = page.getByRole("button", { name: en("folders.list.actionsFor", { name: names.keyboardFolder }), exact: true });
        await actions.focus();
        await page.keyboard.press("Enter");
        await arrowTo(page, page.getByRole("menuitem", { name: en("folders.actions.rename"), exact: true }));
        await page.keyboard.press("Enter");
        const rename = page.getByRole("dialog", { name: en("folders.form.title.rename"), exact: true });
        await expect(rename).toBeVisible();
        const name = rename.getByLabel(en("folders.form.name.label"), { exact: true });
        await waitForInitialFocus(name, "the name field of the Rename folder dialog");
        await tabTo(page, name);
        await expect(name).toHaveValue(names.keyboardFolder);
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(names.renamedFolder);
        await scan();
        await tabTo(page, rename.getByRole("button", { name: en("folders.form.submit.update"), exact: true }));
        const renamed = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.startsWith(`${API.folders}/`));
        await page.keyboard.press("Enter");
        expect((await renamed).status(), "PATCH /api/v1/folders/{id} from the keyboard").toBe(200);
        await expect(rename).toHaveCount(0);
        await expect(row(page, en("folders.list.label"), names.renamedFolder)).toBeVisible();
        await expect(row(page, en("folders.list.label"), names.keyboardFolder)).toHaveCount(0);
      });

      await test.step("deletes the folder while its bookmarks remain", async () => {
        await app.visit("/folders", foldersHeading(page));
        await expect(row(page, en("folders.list.label"), names.folder).getByText(en("folders.list.bookmarkCount", { count: "2" }))).toBeVisible();
        await chooseRowAction(page, en("folders.list.actionsFor", { name: names.folder }), en("folders.actions.delete"));
        const confirm = page.getByRole("alertdialog", { name: en("folders.delete.title", { name: names.folder }), exact: true });
        await expect(confirm).toBeVisible();
        await expect(confirm.getByText(en("folders.delete.description", { count: "2" }), { exact: true })).toBeVisible();
        await scan();

        const removed = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === `${API.folders}/${folderId}`);
        await confirm.getByRole("button", { name: en("folders.delete.confirm"), exact: true }).click();
        expect((await removed).status(), "DELETE /api/v1/folders/{id}").toBe(204);
        await expect(confirm).toHaveCount(0);
        await expect(row(page, en("folders.list.label"), names.folder)).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: en("shell.navigation") }).getByRole("link", { name: names.folder, exact: true })).toHaveCount(0);
        await scan();

        // Both bookmarks that were in the folder are still there, in no folder now, with their tags.
        for (const id of [bookmarkA.id, bookmarkB.id]) {
          const kept = await bookmarkOf(id);
          expect(kept.folders, `the folders of the bookmark ${id} after the folder was deleted`).toEqual([]);
          expect(kept.tags.map((tag) => tag.name)).toContain(names.alpha);
        }
        await app.visit("/bookmarks", listHeading(page));
        await expect(card(page, titles.a)).toBeVisible();
        await expect(card(page, titles.b)).toBeVisible();
      });

      expect(dialogs, "scripts that ran during the journey").toEqual([]);
      finished = true;
    } finally {
      const refused: string[] = [];
      const remove = async (path: string, ...ok: number[]): Promise<void> => {
        const removed = await request.delete(path, { headers: MUTATION });
        if (removed.status() !== 204 && !ok.includes(removed.status())) {
          refused.push(`${path} ${String(removed.status())}`);
        }
      };
      for (const id of made.bookmarkIds) {
        await remove(`${API.bookmarks}/${id}`, 404);
      }
      for (const folder of await listAll<Folder>(request, API.folders)) {
        if (folder.name.includes(token)) {
          await remove(`${API.folders}/${folder.id}`, 404);
        }
      }
      for (const tag of await listAll<Tag>(request, API.tags)) {
        if (tag.name.includes(token)) {
          await remove(`${API.tags}/${tag.id}`, 404);
        }
      }
      if (made.memberAccountId !== undefined) {
        const ended = await request.delete(`${API.members}/${made.memberAccountId}`, { headers: MUTATION, data: { content: "delete" } });
        if (ended.status() !== 200 && ended.status() !== 404) {
          refused.push(`${API.members}/{accountId} ${String(ended.status())}`);
        }
      }
      // A step that failed is the failure to report; the clean-up speaks only when the journey itself passed.
      if (finished && refused.length > 0) {
        throw new Error(`the clean-up of what the journey made was refused: ${refused.join(", ")}`);
      }
    }
  });
});
