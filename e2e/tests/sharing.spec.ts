import { randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse, Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { findViolations, loadAllowlist } from "../support/axe.ts";
import { message } from "../support/catalog.ts";
import { DESTINATION_HEADING, startDestination } from "../support/destination.ts";
import { appOrigin } from "../support/environment.ts";
import { WORKSPACE_NAME } from "../support/instance.ts";
import { openPaletteWithShortcut, paletteDialog } from "../support/palette.ts";
import { expect, test } from "../support/test.ts";

// The sharing journey (doc 08 sections 3.3 and 5.1, doc 02 sections 6.2, 6.3, 6.4 and 8, doc 04 section 2.4, doc 10 T2 and T11), after the first-run setup
// (tests/first-run.setup.ts). The owner of the instance invites two members, Mia and Lee, creates a team with Mia in it and shares a folder with the team in the
// share dialog; Mia, signed in on her own, sees the bookmark in "Shared with me", the folder in "Shared with you" and /go/<slug> forwards to it. Lee shares a
// bookmark with the same slug with Mia in the share dialog, and /go/<slug> and the palette's `go` mode then offer Mia the two: her own bookmark with the slug
// wins over both, a choice made on the page is remembered and listed on the Forwarding page, and the palette follows it. The owner stops sharing the folder,
// and Mia's access, the remembered choice and the bookmark in her lists end at her next request; Lee stops sharing too and the slug is a page that does not
// exist for her. These are scanned for WCAG 2.2 AA violations (support/axe.ts and its allow-list): the share dialog of a folder with a share and without one, the
// share dialog of a bookmark without a share and with one, the dialog that makes the team, the owner's Shared by me list, and Mia's Shared with me, shared folders,
// disambiguation page, palette in go mode, Forwarding page with the remembered choice and without it, page for a slug nobody shares with her and empty Shared with me.
// Every text is read from the catalogs of packages/web.
//
// The journey runs in the dark theme, the owner's and the members' alike. The avatar of a member or a team (packages/ui/src/patterns/account-avatar.tsx) draws
// initials in the page colour on one of the eight colours of the folders, chosen by the identifier of the account, and in the light theme most of the eight
// are below the contrast of 4.5:1 that the initials need, so a scan of a dialog or a list that shows an avatar would pass or fail with the identifiers the run
// happened to draw. In the dark theme every one of the eight meets it.
//
// The journey acts on the one workspace of the stack and reads the language of the account, so it takes the lock of the account's preferences for as long as
// it runs (the `account` fixture), and it removes what it made, also when a step fails: its bookmarks, folder and team, and the two members. Every name carries a
// token made up for this run. It runs in Chromium alone: the members' sessions and the lock make it a long journey. The members' passwords are made up for the
// run and never printed.
//
// A workspace without `sharing.*` hides every sharing control (the web unit tests hold it, packages/web/test/sharing.test.tsx), but the Community Edition image composes
// the full entitlement source (apps/slugbase/src/main.ts) and has no way to start without it, so this journey does not run that case.

const API = {
  bookmarks: "/api/v1/bookmarks",
  folders: "/api/v1/folders",
  teams: "/api/v1/teams",
  invitations: "/api/v1/invitations",
  members: "/api/v1/members",
  me: "/api/v1/me",
  preferences: "/api/v1/me/go-preferences",
} as const;

const NO_SESSION = { cookies: [], origins: [] };

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

/** A mutation must come from the app's origin and be JSON, with or without a body. */
const MUTATION = { origin: appOrigin(), "content-type": "application/json" };

async function json<T>(response: APIResponse, what: string, status: number): Promise<T> {
  const body = await response.text().catch(() => "");
  expect(response.status(), `${what} answered ${String(response.status())}: ${body}`).toBe(status);
  return JSON.parse(body === "" ? "null" : body) as T;
}

interface Member {
  readonly name: string;
  readonly accountId: string;
  readonly context: BrowserContext;
  readonly page: Page;
}

/**
 * The owner invites an address and takes the link the mail would carry from the API, so that the journey does not wait for the mail relay; the address accepts as a new
 * account with a password of its own, in a browser context of its own that keeps the session.
 */
async function provisionMember(browser: Browser, owner: APIRequestContext, name: string, token: string): Promise<Member> {
  const email = `${name.toLowerCase()}-${token}@example.test`;
  const displayName = `${name} ${token}`;
  const password = randomBytes(24).toString("base64url");
  const invitation = await json<{ id: string }>(await owner.post(API.invitations, { headers: MUTATION, data: { email, role: "member" } }), "POST /api/v1/invitations", 201);
  const issued = await json<{ link: string }>(await owner.post(`${API.invitations}/${invitation.id}/link`, { headers: MUTATION }), "POST /api/v1/invitations/{id}/link", 200);
  const invitationToken = issued.link.split("/invite/")[1] ?? "";
  expect(invitationToken, "the token of the invitation link").not.toBe("");
  const context = await browser.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, locale: "en-US", storageState: NO_SESSION });
  try {
    await json(await context.request.post("/api/v1/invitations/accept", { headers: MUTATION, data: { token: invitationToken, displayName, password } }), "POST /api/v1/invitations/accept", 201);
    // The member's language and theme are the account's, so they are set rather than left to what the sign-up chose.
    await json(await context.request.patch(API.me, { headers: MUTATION, data: { theme: "dark", locale: "en" } }), "PATCH /api/v1/me", 200);
    const me = await json<{ account: { id: string } }>(await context.request.get(API.me), "GET /api/v1/me", 200);
    return { name: displayName, accountId: me.account.id, context, page: await context.newPage() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function listHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("bookmarks.page.title") });
}

/** The card of a bookmark of the grid, found by its title. */
function card(page: Page, title: string): Locator {
  return page.locator("[data-item-id]").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

async function scanPage(page: Page, what: string): Promise<void> {
  expect(await findViolations(page, loadAllowlist()), `WCAG 2.2 AA violations on ${what}`).toEqual([]);
}

/** The share dialog, found by its title; `kind` says what is shared. */
function shareDialog(page: Page, kind: "bookmark" | "folder", name: string): Locator {
  return page.getByRole("dialog", { name: en(`sharing.dialog.title.${kind}`, { name }), exact: true });
}

/** Adds a member or a team to the open share dialog: the picker is searched for the name and the entry chosen. */
async function addShare(page: Page, dialog: Locator, name: string): Promise<void> {
  const picker = dialog.getByRole("combobox", { name: en("sharing.dialog.picker.label"), exact: true });
  await expect(picker).toBeEnabled();
  await picker.fill(name);
  await page.getByRole("option", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
  await expect(dialog.getByRole("list", { name: en("sharing.dialog.list.label"), exact: true }).getByText(name, { exact: true })).toBeVisible();
}

test.describe("sharing journey", () => {
  // A click that finds its target covered waits for the test to time out unless the actions are bounded.
  test.use({ actionTimeout: 15_000 });
  test.skip(({ browserName }) => browserName !== "chromium", "the journey is Chromium's: it holds the lock of the account's preferences and two members' sessions");

  test("shares a folder with a team and a bookmark with a member, goes by own-first and by disambiguation, remembers a choice, and access ends when the shares do", async ({
    page,
    app,
    account,
    browser,
  }) => {
    test.setTimeout(420_000);
    await account.set({ theme: "dark", locale: "en" });

    const token = randomBytes(4).toString("hex");
    const slug = `shared-${token}`;
    const names = {
      folder: `Shared folder ${token}`,
      team: `Readers ${token}`,
      owners: `Owner docs ${token}`,
      private: `Owner private ${token}`,
      lees: `Lee docs ${token}`,
      mias: `Mia docs ${token}`,
    };
    const request = page.request;
    const destination = await startDestination();
    const members: Member[] = [];
    const made = { folder: "", team: "", bookmarks: [] as { request: APIRequestContext; id: string }[] };

    // A toast of an earlier step is not part of the page or the dialog under test, and a toast does not go while the pointer rests on its stack.
    const scan = async (): Promise<void> => {
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
      await app.scan();
    };
    const createBookmark = async (as: APIRequestContext, body: Record<string, unknown>, what: string): Promise<string> => {
      const created = await json<{ id: string }>(await as.post(API.bookmarks, { headers: MUTATION, data: body }), what, 201);
      made.bookmarks.push({ request: as, id: created.id });
      return created.id;
    };

    let finished = false;
    try {
      const mia = await provisionMember(browser, request, "Mia", token);
      members.push(mia);
      const lee = await provisionMember(browser, request, "Lee", token);
      members.push(lee);
      const owner = await json<{ account: { id: string; displayName: string } }>(await request.get(API.me), "GET /api/v1/me", 200);

      made.folder = (await json<{ id: string }>(await request.post(API.folders, { headers: MUTATION, data: { name: names.folder } }), "POST /api/v1/folders", 201)).id;
      const ownersBookmark = await createBookmark(request, { url: destination.url("/owners"), title: names.owners, slug, folderIds: [made.folder] }, "POST /api/v1/bookmarks of the owner");
      await createBookmark(request, { url: destination.url("/private"), title: names.private }, "POST /api/v1/bookmarks of the private bookmark");
      const leesBookmark = await createBookmark(lee.context.request, { url: destination.url("/lees"), title: names.lees, slug }, "POST /api/v1/bookmarks of Lee");

      await test.step("the owner makes a team with Mia in it, and shares the folder with the team in the share dialog", async () => {
        await app.visit("/settings/workspace/teams", page.getByRole("heading", { level: 1, name: en("teams.title"), exact: true }));
        await page.getByRole("button", { name: en("teams.create"), exact: true }).first().click();
        const form = page.getByRole("dialog", { name: en("teams.form.title.create"), exact: true });
        await expect(form).toBeVisible();
        await form.getByRole("textbox", { name: en("teams.form.name.label"), exact: true }).fill(names.team);
        await form.getByLabel(en("teams.form.members.label"), { exact: true }).fill(mia.name);
        await page.getByRole("option", { name: new RegExp(`^${mia.name}`) }).click();
        // The list of the field closes before the dialog is scanned, so the scan sees the dialog and not a popup over it.
        await form.getByRole("heading", { name: en("teams.form.title.create"), exact: true }).click();
        await expect(page.locator("[data-slot='multi-pick-popup']")).toHaveCount(0);
        await scan();
        const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === API.teams);
        await form.getByRole("button", { name: en("teams.form.submit.create"), exact: true }).click();
        const response = await created;
        expect(response.status(), "POST /api/v1/teams").toBe(201);
        made.team = ((await response.json()) as { id: string }).id;
        await expect(form).toHaveCount(0);

        await app.visit("/folders", page.getByRole("heading", { level: 1, name: en("folders.page.title"), exact: true }));
        await page.getByRole("button", { name: en("folders.list.actionsFor", { name: names.folder }), exact: true }).click();
        await page.getByRole("menuitem", { name: en("folders.actions.share"), exact: true }).click();
        const dialog = shareDialog(page, "folder", names.folder);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(en("sharing.dialog.list.empty"), { exact: true })).toBeVisible();
        await addShare(page, dialog, names.team);
        await expect(dialog.getByText(en("sharing.dialog.audience.some", { count: "1" }), { exact: true })).toBeVisible();
        await expect(dialog.getByRole("note")).toContainText(en("sharing.dialog.note.folder"));
        await scan();
        await dialog.getByRole("button", { name: en("sharing.dialog.done"), exact: true }).click();
        await expect(dialog).toHaveCount(0);

        // The owner sees the bookmark in "Shared by me" and not the one nobody has.
        await app.visit("/bookmarks?scope=shared_by_me", listHeading(page));
        await expect(card(page, names.owners)).toBeVisible();
        await expect(card(page, names.private)).toHaveCount(0);
        await scan();
      });

      await test.step("Mia sees the bookmark in Shared with me and the folder in Shared with you, and /go/<slug> forwards to the bookmark", async () => {
        const hers = mia.page;
        await hers.goto("/bookmarks?scope=shared_with_me");
        await expect(listHeading(hers)).toBeVisible();
        const shared = card(hers, names.owners);
        await expect(shared).toBeVisible();
        await expect(shared.getByText(en("bookmarks.list.shared.marker"), { exact: true })).toBeVisible();
        await expect(shared.getByText(owner.account.displayName, { exact: true })).toBeVisible();
        await expect(card(hers, names.private)).toHaveCount(0);
        await scanPage(hers, "Mia's Shared with me");

        await hers.goto("/folders?scope=shared");
        await expect(hers.getByRole("heading", { level: 1, name: en("folders.page.title"), exact: true })).toBeVisible();
        await expect(hers.getByRole("table", { name: en("folders.list.label"), exact: true }).getByRole("row").filter({ hasText: names.folder })).toBeVisible();
        await expect(hers.getByRole("navigation", { name: en("shell.navigation") }).getByText(en("shell.foldersSection.shared"), { exact: true })).toBeVisible();
        await scanPage(hers, "Mia's shared folders");

        await hers.goto(`/go/${slug}`);
        await expect(hers).toHaveURL(destination.url("/owners"));
        await expect(hers.getByRole("heading", { level: 1, name: DESTINATION_HEADING })).toBeVisible();
      });

      await test.step("Lee shares his bookmark with Mia in the share dialog, and /go/<slug> offers her the two bookmarks", async () => {
        const his = lee.page;
        await his.goto("/bookmarks");
        await expect(listHeading(his)).toBeVisible();
        await his.getByRole("button", { name: en("bookmarks.list.actionsFor", { title: names.lees }), exact: true }).click();
        await his.getByRole("menuitem", { name: en("bookmarks.list.share"), exact: true }).click();
        const dialog = shareDialog(his, "bookmark", names.lees);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(en("sharing.dialog.list.empty"), { exact: true })).toBeVisible();
        await scanPage(his, "Lee's share dialog of a bookmark without a share");
        await addShare(his, dialog, mia.name);
        await scanPage(his, "Lee's share dialog of a bookmark with a share");
        await dialog.getByRole("button", { name: en("sharing.dialog.done"), exact: true }).click();
        await expect(dialog).toHaveCount(0);

        const hers = mia.page;
        await hers.goto(`/go/${slug}`);
        await expect(hers.getByRole("heading", { level: 1, name: en("go.choose.title", { slug, count: "2" }), exact: true })).toBeVisible();
        const choices = hers.getByRole("group", { name: en("go.choose.label"), exact: true });
        await expect(choices.getByRole("button")).toHaveCount(2);
        await expect(choices.getByRole("button", { name: new RegExp(`${names.owners}.*${en("go.choose.sharedBy", { owner: owner.account.displayName })}.*${en("go.choose.via.folder")}`) })).toBeVisible();
        await expect(choices.getByRole("button", { name: new RegExp(`${names.lees}.*${en("go.choose.sharedBy", { owner: lee.name })}.*${en("go.choose.via.direct")}`) })).toBeVisible();
        await scanPage(hers, "Mia's disambiguation page");
      });

      await test.step("the palette offers the same two bookmarks in place, and a choice that is not remembered forwards once", async () => {
        const hers = mia.page;
        await hers.goto("/bookmarks");
        await expect(listHeading(hers)).toBeVisible();
        await openPaletteWithShortcut(hers);
        await hers.keyboard.type(`go ${slug}`);
        const dialog = paletteDialog(hers);
        await expect(dialog.getByText(en("palette.go.mode"), { exact: true })).toBeVisible();
        await hers.keyboard.press("Enter");
        await expect(dialog.getByRole("option", { name: new RegExp(`^${names.owners}`) })).toBeVisible();
        await expect(dialog.getByRole("option", { name: new RegExp(`^${names.lees}`) })).toBeVisible();
        await expect(dialog.getByRole("option", { name: en("go.choose.always", { slug }), exact: true })).toBeVisible();
        await scanPage(hers, "Mia's palette in go mode with two bookmarks");
        await dialog.getByRole("option", { name: new RegExp(`^${names.lees}`) }).click();
        await expect(hers).toHaveURL(destination.url("/lees"));
        expect(await (await hers.request.get(API.preferences)).json(), "nothing was remembered").toMatchObject({ items: [] });
      });

      await test.step("Mia's own bookmark with the slug wins over both, on the page and in the palette", async () => {
        const hers = mia.page;
        const own = await createBookmark(mia.context.request, { url: destination.url("/mias"), title: names.mias, slug }, "POST /api/v1/bookmarks of Mia");
        await hers.goto(`/go/${slug}`);
        await expect(hers).toHaveURL(destination.url("/mias"));

        await hers.goto("/bookmarks");
        await expect(listHeading(hers)).toBeVisible();
        await openPaletteWithShortcut(hers);
        await hers.keyboard.type(`go ${slug}`);
        await hers.keyboard.press("Enter");
        await expect(hers).toHaveURL(destination.url("/mias"));

        // Without it the two shared bookmarks are offered again.
        expect((await mia.context.request.delete(`${API.bookmarks}/${own}`, { headers: MUTATION })).status(), "DELETE /api/v1/bookmarks/{id} of Mia's").toBe(204);
        made.bookmarks = made.bookmarks.filter((entry) => entry.id !== own);
        await hers.goto(`/go/${slug}`);
        await expect(hers.getByRole("heading", { level: 1, name: en("go.choose.title", { slug, count: "2" }), exact: true })).toBeVisible();
      });

      await test.step("Always use this remembers the owner's bookmark, lists it on the Forwarding page and makes /go and the palette forward at once", async () => {
        const hers = mia.page;
        await hers.getByRole("checkbox", { name: en("go.choose.always", { slug }), exact: true }).check();
        await hers.getByRole("group", { name: en("go.choose.label"), exact: true }).getByRole("button", { name: new RegExp(`^${names.owners}`) }).click();
        await expect(hers).toHaveURL(destination.url("/owners"));

        await hers.goto(`/go/${slug}`);
        await expect(hers).toHaveURL(destination.url("/owners"));

        await hers.goto("/forwarding");
        await expect(hers.getByRole("heading", { level: 1, name: en("forwarding.page.title"), exact: true })).toBeVisible();
        const choices = hers.getByRole("table", { name: en("forwarding.choices.label"), exact: true });
        const remembered = choices.getByRole("row").filter({ hasText: slug });
        await expect(remembered).toContainText(names.owners);
        await expect(remembered).toContainText(owner.account.displayName);
        await scanPage(hers, "Mia's Forwarding page with a remembered choice");

        await hers.goto("/bookmarks");
        await expect(listHeading(hers)).toBeVisible();
        await openPaletteWithShortcut(hers);
        await hers.keyboard.type(`go ${slug}`);
        await hers.keyboard.press("Enter");
        await expect(hers).toHaveURL(destination.url("/owners"));
      });

      await test.step("the owner stops sharing the folder, and Mia's access and her remembered choice end at her next request", async () => {
        await app.visit("/folders", page.getByRole("heading", { level: 1, name: en("folders.page.title"), exact: true }));
        await page.getByRole("button", { name: en("folders.list.actionsFor", { name: names.folder }), exact: true }).click();
        await page.getByRole("menuitem", { name: en("folders.actions.share"), exact: true }).click();
        const dialog = shareDialog(page, "folder", names.folder);
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: en("sharing.dialog.row.remove", { name: names.team }), exact: true }).click();
        await expect(dialog.getByText(en("sharing.dialog.list.empty"), { exact: true })).toBeVisible();
        await scan();
        await dialog.getByRole("button", { name: en("sharing.dialog.done"), exact: true }).click();
        await expect(dialog).toHaveCount(0);

        const hers = mia.page;
        expect((await mia.context.request.get(`${API.bookmarks}/${ownersBookmark}`)).status(), "GET /api/v1/bookmarks/{id} of the owner's bookmark").toBe(404);
        await hers.goto("/bookmarks?scope=shared_with_me");
        await expect(listHeading(hers)).toBeVisible();
        await expect(card(hers, names.lees)).toBeVisible();
        await expect(card(hers, names.owners)).toHaveCount(0);
        await hers.goto("/forwarding");
        await expect(hers.getByRole("heading", { level: 1, name: en("forwarding.page.title"), exact: true })).toBeVisible();
        await expect(hers.getByRole("heading", { name: en("forwarding.choices.empty.title"), exact: true })).toBeVisible();
        await scanPage(hers, "Mia's Forwarding page without the choice");

        // Only Lee's bookmark has the slug for her now: it forwards at once.
        await hers.goto(`/go/${slug}`);
        await expect(hers).toHaveURL(destination.url("/lees"));
      });

      await test.step("Lee stops sharing, and the slug is a page that does not exist for Mia and Shared with me is empty", async () => {
        const his = lee.page;
        await his.goto("/bookmarks");
        await expect(listHeading(his)).toBeVisible();
        await his.getByRole("button", { name: en("bookmarks.list.actionsFor", { title: names.lees }), exact: true }).click();
        await his.getByRole("menuitem", { name: en("bookmarks.list.share"), exact: true }).click();
        const dialog = shareDialog(his, "bookmark", names.lees);
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: en("sharing.dialog.row.remove", { name: mia.name }), exact: true }).click();
        await expect(dialog.getByText(en("sharing.dialog.list.empty"), { exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: en("sharing.dialog.done"), exact: true }).click();
        expect((await mia.context.request.get(`${API.bookmarks}/${leesBookmark}`)).status(), "GET /api/v1/bookmarks/{id} of Lee's bookmark").toBe(404);

        const hers = mia.page;
        await hers.goto(`/go/${slug}`);
        await expect(hers.getByRole("heading", { level: 1, name: en("go.notFound.title", { slug, workspace: WORKSPACE_NAME }), exact: true })).toBeVisible();
        await scanPage(hers, "Mia's page for a slug nobody shares with her");

        await hers.goto("/bookmarks?scope=shared_with_me");
        await expect(hers.getByRole("heading", { name: en("bookmarks.list.empty.sharedWithMe.title"), exact: true })).toBeVisible();
        await scanPage(hers, "Mia's empty Shared with me");
      });
      finished = true;
    } finally {
      // What the journey made, removed through the sessions that made it; a step that failed is the failure to report.
      const refused: string[] = [];
      const gone = async (what: string, removal: Promise<APIResponse>, ok: readonly number[]): Promise<void> => {
        const status = (await removal.catch(() => undefined))?.status();
        if (status === undefined || !ok.includes(status)) {
          refused.push(`${what} ${String(status)}`);
        }
      };
      for (const { request: as, id } of made.bookmarks) {
        await gone("DELETE /api/v1/bookmarks/{id}", as.delete(`${API.bookmarks}/${id}`, { headers: MUTATION }), [204, 404]);
      }
      if (made.team !== "") {
        await gone("DELETE /api/v1/teams/{id}", request.delete(`${API.teams}/${made.team}`, { headers: MUTATION }), [204, 404]);
      }
      if (made.folder !== "") {
        await gone("DELETE /api/v1/folders/{id}", request.delete(`${API.folders}/${made.folder}`, { headers: MUTATION }), [204, 404]);
      }
      for (const member of members) {
        await gone("DELETE /api/v1/members/{accountId}", request.delete(`${API.members}/${member.accountId}`, { headers: MUTATION, data: { content: "delete" } }), [200, 404]);
        await member.context.close();
      }
      await destination.close();
      if (finished && refused.length > 0) {
        throw new Error(`the clean-up of what the journey made was refused: ${refused.join(", ")}`);
      }
    }
  });
});
