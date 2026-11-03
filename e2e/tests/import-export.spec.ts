import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIResponse, Locator, Page, PlaywrightWorkerArgs } from "@playwright/test";
import { bookmarkBody, bookmarkShape } from "../support/bookmark-fixtures.ts";
import { message } from "../support/catalog.ts";
import { appOrigin, STORAGE_STATE } from "../support/environment.ts";
import { createWorkspace, type CreatedWorkspace } from "../support/instance-admin.ts";
import { comparableExport, isWebAddress, linksOfBookmarkFile } from "../support/round-trip.ts";
import { expect, test } from "../support/test.ts";

// The import-and-export journey (doc 08 section 5.1, doc 02 sections 13.2 and 13.4, doc 03 section 11.5, doc 12 Phase 4 definition of done, doc 10 T13, Q29), after the
// first-run setup (tests/first-run.setup.ts). A member fills a workspace through the API: folders with an icon and a colour (one of them unused), tags, a slug that forwards and
// one that does not, pinned bookmarks, a remembered slug choice, three addresses with one canonical form, and titles that are markup, right-to-left text, emoji and the longest a
// bookmark has. The member exports it as SlugBase JSON on the Import & export page, an instance admin makes a fresh workspace for the member, and the member imports the file
// there through the wizard, with "Skip duplicates" off, and exports again. The two files are compared byte for byte once `exportedAt` and the workspace's name, the two fields that
// are meant to differ, are removed; a document holds no identifier (#257), so nothing else may differ. The member then imports each of the four browser files of
// packages/core/test/fixtures/import/netscape/ (Chrome, Edge, Firefox, Safari) and exports the workspace as a browser file after each, which holds every title and every http
// and https address of the file it came from. The wizard turns away a file of a newer version, a file over 5 MiB and a file of another type with the messages of the catalog.
// The page is scanned for WCAG 2.2 AA violations in each state the journey reaches (tests/axe.spec.ts, support/axe.ts). Every text is read from the catalogs of packages/web.
//
// The journey acts as a member of its own: it invites an address, accepts the invitation as a new account with a password made up for the run, and the switch to the fresh
// workspace is kept in that member's session, not in the owner's, which the other journeys share. It makes nothing of the owner's and needs no lock of the account's preferences.
// The member is removed from the workspace with its bookmarks, and its account is deleted with the fresh workspace, when the journey ends, also when a step fails. The password
// is never printed. It runs in Chromium alone: the length of the journey, and the limits of the bulk bucket that the e2e stack lifts (compose.e2e.yml), are not worth three engines.
//
// Not covered: a plan-archived bookmark, which only a downgrade of the plan makes (packages/server/test/routes/import-export-round-trip.integration.test.ts holds it), and
// a title that holds a line break or a tab, which an import removes as it does every control character of a file (doc 10 T13).

type Playwrights = PlaywrightWorkerArgs["playwright"];

const DATA = "/settings/account/data";
const API = {
  bookmarks: "/api/v1/bookmarks",
  folders: "/api/v1/folders",
  tags: "/api/v1/tags",
  invitations: "/api/v1/invitations",
  members: "/api/v1/members",
  me: "/api/v1/me",
  reauth: "/api/v1/me/reauth",
  choose: "/api/v1/go/choose",
  activeWorkspace: "/api/v1/session/active-workspace",
} as const;

const NO_SESSION = { cookies: [], origins: [] };
const AUTH_DIRECTORY = dirname(STORAGE_STATE);
const FIXTURES = fileURLToPath(new URL("../../packages/core/test/fixtures/import/netscape/", import.meta.url));
const BROWSERS = ["chrome", "edge", "firefox", "safari"] as const;
/** The largest file the wizard takes, as it says so itself (`data.import.file.description`); the test below holds the copy to it. */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

/** A mutation must come from the origin the server is configured with and be JSON, with or without a body. */
function mutation(data?: unknown): { headers: Record<string, string>; data?: unknown } {
  return { headers: { origin: appOrigin(), "content-type": "application/json" }, ...(data === undefined ? {} : { data }) };
}

async function expectStatus(response: APIResponse, status: number, what: string): Promise<void> {
  const body = await response.text().catch(() => "");
  expect(response.status(), `${what} answered ${String(response.status())}: ${body}`).toBe(status);
}

async function created(response: APIResponse, what: string): Promise<{ id: string }> {
  await expectStatus(response, 201, what);
  return (await response.json()) as { id: string };
}

interface Member {
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
}

/**
 * The owner invites an address and takes the link the mail would carry from the API, and the address accepts as a new account with a password of its own. The session
 * of that account is kept in `statePath`, as the state the journey starts from.
 */
async function provisionMember(playwright: Playwrights, token: string, statePath: string): Promise<Member> {
  const email = `import-export-${token}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const options = { baseURL: appOrigin(), ignoreHTTPSErrors: true } as const;
  const owner = await playwright.request.newContext({ ...options, storageState: STORAGE_STATE });
  const visitor = await playwright.request.newContext({ ...options, storageState: NO_SESSION });
  try {
    const invitation = await created(await owner.post(API.invitations, mutation({ email, role: "member" })), "POST /api/v1/invitations");
    const link = await owner.post(`${API.invitations}/${invitation.id}/link`, mutation());
    await expectStatus(link, 200, "POST /api/v1/invitations/{id}/link");
    const invitationToken = ((await link.json()) as { link: string }).link.split("/invite/")[1] ?? "";
    expect(invitationToken, "the token of the invitation link").not.toBe("");
    await expectStatus(
      await visitor.post("/api/v1/invitations/accept", mutation({ token: invitationToken, displayName: `Import Export ${token}`, password })),
      201,
      "POST /api/v1/invitations/accept",
    );
    // The member's language is the account's, so it is set rather than left to what the sign-up chose.
    await expectStatus(await visitor.patch(API.me, mutation({ locale: "en" })), 200, "PATCH /api/v1/me");
    const me = (await (await visitor.get(API.me)).json()) as { account?: { id?: unknown } };
    const accountId = me.account?.id;
    if (typeof accountId !== "string") {
      throw new Error("GET /api/v1/me answered without the account's id");
    }
    mkdirSync(AUTH_DIRECTORY, { recursive: true });
    await visitor.storageState({ path: statePath });
    return { email, password, accountId };
  } finally {
    await owner.dispose();
    await visitor.dispose();
  }
}

/**
 * Takes away what the journey made: the owner removes the member from the workspace with the member's bookmarks, and the member, who re-authenticates with the password of
 * the run, deletes the account, which deletes the fresh workspace the member was alone in. Every step is tried; the ones that failed are told together.
 */
async function retireMember(playwright: Playwrights, member: Member, statePath: string): Promise<void> {
  const options = { baseURL: appOrigin(), ignoreHTTPSErrors: true } as const;
  const owner = await playwright.request.newContext({ ...options, storageState: STORAGE_STATE });
  const own = await playwright.request.newContext({ ...options, storageState: statePath });
  const refused: string[] = [];
  const attempt = async (what: string, status: number, call: () => Promise<APIResponse>): Promise<void> => {
    try {
      const response = await call();
      if (response.status() !== status) {
        refused.push(`${what} ${String(response.status())}`);
      }
    } catch (error) {
      refused.push(`${what} ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    await attempt("DELETE /api/v1/members/{accountId}", 200, () => owner.delete(`${API.members}/${member.accountId}`, mutation({ content: "delete" })));
    await attempt("POST /api/v1/me/reauth", 204, () => own.post(API.reauth, mutation({ password: member.password })));
    await attempt("DELETE /api/v1/me", 204, () => own.delete(API.me, mutation({ email: member.email })));
  } finally {
    await owner.dispose();
    await own.dispose();
  }
  expect(refused, "what the journey could not take away").toEqual([]);
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The heading of the page. */
function pageHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("data.title"), exact: true });
}

/** The heading of a step of the wizard. */
function stepHeading(page: Page, key: string): Locator {
  return page.getByRole("heading", { level: 3, name: en(key), exact: true });
}

/** The button that moves the wizard on, found by what it says. */
function wizardButton(page: Page, key: string): Locator {
  return page.getByRole("button", { name: en(key), exact: true });
}

/** The figure of a row of the preview, found by its label. */
function previewFigure(page: Page, key: string): Locator {
  return page
    .locator("dt")
    .filter({ hasText: new RegExp(`^${escapePattern(en(key))}$`) })
    .locator("xpath=following-sibling::dd");
}

/** The figure of a tile of the result, found by its label. */
function resultFigure(page: Page, key: string): Locator {
  return page
    .locator("p")
    .filter({ hasText: new RegExp(`^${escapePattern(en(key))}$`) })
    .locator("xpath=following-sibling::p");
}

/** Chooses a file in the wizard, the way the file picker reports it. */
async function chooseFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator("input[type='file']").setInputFiles(file);
}

/** Downloads the export of the Import & export page in a format and returns the bytes of the file as text. */
async function exportFile(page: Page, format: "json" | "netscape"): Promise<{ text: string; name: string }> {
  const choice = page.getByRole("radio", { name: en(`data.export.format.${format}.label`), exact: true });
  if (!(await choice.isChecked())) {
    await choice.click();
  }
  await expect(choice).toBeChecked();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: en("data.export.download"), exact: true }).click();
  const file = await download;
  const path = await file.path();
  return { text: readFileSync(path, "utf8"), name: file.suggestedFilename() };
}

test.describe("import and export journey", () => {
  // A click that finds its target covered waits for the test to time out unless the actions are bounded.
  test.use({ actionTimeout: 15_000 });
  test.skip(({ browserName }) => browserName !== "chromium", "the journey is Chromium's: it is long, and it takes tokens of the bulk bucket that the stack lifts for one run");

  const token = randomBytes(4).toString("hex");
  const statePath = join(AUTH_DIRECTORY, `import-export-${token}.json`);
  let member: Member | undefined;

  test.use({ storageState: statePath });

  test.beforeAll(async ({ playwright }) => {
    member = await provisionMember(playwright, token, statePath);
  });

  test.afterAll(async ({ playwright }) => {
    try {
      if (member !== undefined) {
        await retireMember(playwright, member, statePath);
      }
    } finally {
      rmSync(statePath, { force: true });
    }
  });

  test("exports a workspace, imports the file into a fresh one and exports the same document, and reads the files of the four browsers", async ({ page, app, playwright }) => {
    test.setTimeout(420_000);
    const account = member;
    if (account === undefined) {
      throw new Error("the member was not set up before the journey");
    }
    expect(en("data.import.file.description"), "the wizard states the 5 MiB the test sends one byte more than").toContain("5 MiB");

    // A toast of an earlier step is not part of the page under test, and the ones stacked behind the frontmost have a darkened background of their own, so each scan
    // waits for them to go. A toast does not go while the pointer rests on its stack, so the pointer is moved off first.
    const scan = async (): Promise<void> => {
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
      await app.scan();
    };

    const request = page.request;
    const names = {
      hostileFolder: `<img src=x onerror=alert(1)> ${token}`,
      unicodeFolder: `Ünïcödé Ordner 日本語 ${token}`,
      unusedFolder: `Unused ${token}`,
      alpha: `alpha-${token}`,
      japanese: `日本語-${token}`,
      unusedTag: `unused-${token}`,
      hostileSlug: `hostile-${token}`,
      emojiSlug: `emoji-${token}`,
    };

    await test.step("fills the workspace through the API", async () => {
      const hostileFolder = await created(await request.post(API.folders, mutation({ name: names.hostileFolder, icon: "rocket", color: 5 })), "POST /api/v1/folders of the hostile folder");
      const unicodeFolder = await created(await request.post(API.folders, mutation({ name: names.unicodeFolder, icon: "graduation-cap", color: 8 })), "POST /api/v1/folders of the unicode folder");
      await created(await request.post(API.folders, mutation({ name: names.unusedFolder, icon: "star", color: 2 })), "POST /api/v1/folders of the unused folder");
      const alpha = await created(await request.post(API.tags, mutation({ name: names.alpha })), "POST /api/v1/tags of alpha");
      const japanese = await created(await request.post(API.tags, mutation({ name: names.japanese })), "POST /api/v1/tags of the japanese tag");
      await created(await request.post(API.tags, mutation({ name: names.unusedTag })), "POST /api/v1/tags of the unused tag");

      const body = (shape: Parameters<typeof bookmarkShape>[0], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...bookmarkBody(bookmarkShape(shape)), ...extra });
      const hostile = await created(
        await request.post(API.bookmarks, mutation(body("markup-title", { slug: names.hostileSlug, forwarding: true, folderIds: [hostileFolder.id], tagIds: [alpha.id] }))),
        "POST /api/v1/bookmarks of the markup title",
      );
      for (const [what, extra] of [
        ["rtl-arabic", { folderIds: [hostileFolder.id, unicodeFolder.id], tagIds: [japanese.id] }],
        ["emoji", { slug: names.emojiSlug, forwarding: false, tagIds: [alpha.id, japanese.id] }],
        ["duplicate-canonical-a", {}],
        ["duplicate-canonical-b", { pinned: true }],
        ["duplicate-canonical-c", {}],
        ["pinned-opened", {}],
        ["longest-title", {}],
      ] as const) {
        await created(await request.post(API.bookmarks, mutation(body(what, extra))), `POST /api/v1/bookmarks of ${what}`);
      }
      await created(await request.post(API.bookmarks, mutation({ url: `https://example.com/plain-${token}`, title: `Plain ${token}` })), "POST /api/v1/bookmarks of the plain one");
      await expectStatus(await request.post(API.choose, mutation({ slug: names.hostileSlug, bookmarkId: hostile.id, remember: true })), 200, "POST /api/v1/go/choose");
    });

    let first = { text: "", name: "" };
    await test.step("exports SlugBase JSON from the page", async () => {
      await app.visit(DATA, pageHeading(page));
      await expect(stepHeading(page, "data.import.step1.title")).toBeVisible();
      await scan();
      const choice = page.getByRole("radio", { name: en("data.export.format.json.label"), exact: true });
      await expect(choice).toBeChecked();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: en("data.export.download"), exact: true }).click();
      const file = await download;
      first = { text: readFileSync(await file.path(), "utf8"), name: file.suggestedFilename() };
      expect(first.name).toMatch(/^slugbase-export-\d{4}-\d{2}-\d{2}\.json$/);
      await expect(page.locator("[data-slot='toast-title']").filter({ hasText: en("data.export.success") })).toBeVisible();
      await scan();

      const document = JSON.parse(first.text) as {
        folders: { name: string; icon: string; color: number }[];
        tags: string[];
        bookmarks: { slug: string | null; forwarding: boolean; pinned: boolean; folders: string[]; tags: string[]; description: string | null }[];
        goPreferences: { slug: string }[];
      };
      // A document that holds nothing would be equal to any other, so what the journey made is in it, and no identifier is.
      expect(first.text, "an identifier in the document").not.toMatch(UUID);
      expect(document.folders).toContainEqual({ name: names.hostileFolder, icon: "rocket", color: 5 });
      expect(document.folders).toContainEqual({ name: names.unicodeFolder, icon: "graduation-cap", color: 8 });
      expect(document.folders).toContainEqual({ name: names.unusedFolder, icon: "star", color: 2 });
      expect(document.tags).toEqual(expect.arrayContaining([names.alpha, names.japanese, names.unusedTag]));
      expect(document.bookmarks).toHaveLength(9);
      expect(document.bookmarks.filter((entry) => entry.pinned).length).toBeGreaterThanOrEqual(2);
      expect(document.bookmarks.filter((entry) => entry.slug !== null && entry.forwarding)).toHaveLength(1);
      expect(document.bookmarks.filter((entry) => entry.slug !== null && !entry.forwarding)).toHaveLength(1);
      expect(document.bookmarks.filter((entry) => entry.description === null).length).toBeGreaterThan(0);
      expect(document.bookmarks.filter((entry) => entry.folders.length > 0 && entry.tags.length > 0)).not.toHaveLength(0);
      expect(document.goPreferences).toEqual([{ slug: names.hostileSlug, bookmarkRef: expect.stringMatching(/^b\d+$/) }]);
    });

    let fresh: CreatedWorkspace | undefined;
    await test.step("makes a fresh workspace for the member and switches to it", async () => {
      const owner = await playwright.request.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, storageState: STORAGE_STATE });
      try {
        // CE does not let an ordinary account create a workspace: the instance admin makes one with the member as its owner.
        fresh = await createWorkspace(owner, `Fresh ${token}`, { ownerAccountId: account.accountId });
      } finally {
        await owner.dispose();
      }
      await expectStatus(await request.put(API.activeWorkspace, mutation({ workspaceId: fresh.id })), 204, "PUT /api/v1/session/active-workspace");
      await app.visit(DATA, pageHeading(page));
      await expect(stepHeading(page, "data.import.step1.title")).toBeVisible();
    });
    if (fresh === undefined) {
      throw new Error("the fresh workspace was not made");
    }
    const workspace = fresh;

    await test.step("imports the file through the wizard without skipping duplicates, and the export of the fresh workspace is the same document", async () => {
      // The file is chosen under the name the download carried: the temporary file Playwright keeps has none that tells its format.
      await chooseFile(page, { name: first.name, mimeType: "application/json", buffer: Buffer.from(first.text, "utf8") });
      await expect(page.locator("[data-slot='file-drop-name']")).toHaveText(first.name);
      await wizardButton(page, "data.import.next.preview").click();
      await expect(stepHeading(page, "data.import.step2.title")).toBeVisible();
      await expect(page.getByText(en("data.import.preview.target", { workspace: workspace.name }), { exact: true })).toBeVisible();
      await expect(previewFigure(page, "data.import.count.bookmarks")).toHaveText("9");
      await expect(previewFigure(page, "data.import.count.folders")).toHaveText("3");
      await expect(previewFigure(page, "data.import.count.tags")).toHaveText("3");
      // The three addresses with one canonical form are duplicates of one another, and the wizard skips them unless it is told not to.
      await expect(previewFigure(page, "data.import.preview.created")).toHaveText("7");
      await expect(previewFigure(page, "data.import.preview.skippedDuplicate")).toHaveText("2");
      const skip = page.getByRole("checkbox", { name: en("data.import.skipDuplicates"), exact: true });
      await expect(skip).toBeChecked();
      await skip.click();
      await expect(skip).not.toBeChecked();
      await expect(previewFigure(page, "data.import.preview.created")).toHaveText("9");
      await expect(previewFigure(page, "data.import.preview.skippedDuplicate")).toHaveText("0");
      await expect(previewFigure(page, "data.import.preview.foldersCreated")).toHaveText("3");
      await expect(previewFigure(page, "data.import.preview.tagsCreated")).toHaveText("3");
      await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
      await scan();

      await wizardButton(page, "data.import.next.import").click();
      await expect(stepHeading(page, "data.import.step3.title.done")).toBeVisible();
      await expect(resultFigure(page, "data.import.result.created")).toHaveText("9");
      await expect(resultFigure(page, "data.import.result.skipped")).toHaveText("0");
      await expect(resultFigure(page, "data.import.result.failed")).toHaveText("0");
      await expect(resultFigure(page, "data.import.result.slugsDropped")).toHaveText("0");
      await expect(page.getByText(en("data.import.result.nothingLeftOut"), { exact: true })).toBeVisible();
      await scan();

      const second = await exportFile(page, "json");
      expect(second.name).toMatch(/^slugbase-export-\d{4}-\d{2}-\d{2}\.json$/);
      expect(second.text, "an identifier in the document").not.toMatch(UUID);
      expect((JSON.parse(second.text) as { workspace: unknown }).workspace).toEqual({ name: workspace.name });
      expect(comparableExport(second.text)).toBe(comparableExport(first.text));
      await scan();
    });

    for (const browser of BROWSERS) {
      await test.step(`imports the ${browser} bookmark file and exports a browser file that holds its titles and addresses`, async () => {
        const html = readFileSync(join(FIXTURES, `${browser}.html`), "utf8");
        const links = linksOfBookmarkFile(html);
        const web = links.filter((link) => isWebAddress(link.url));
        expect(web.length, `the ${browser} file holds web addresses`).toBeGreaterThan(0);

        await wizardButton(page, "data.import.next.another").click();
        await expect(stepHeading(page, "data.import.step1.title")).toBeVisible();
        await chooseFile(page, join(FIXTURES, `${browser}.html`));
        await wizardButton(page, "data.import.next.preview").click();
        await expect(stepHeading(page, "data.import.step2.title")).toBeVisible();
        await expect(previewFigure(page, "data.import.count.bookmarks")).toHaveText(String(links.length));
        await expect(previewFigure(page, "data.import.preview.created")).toHaveText(String(web.length));
        await expect(previewFigure(page, "data.import.preview.failed")).toHaveText(String(links.length - web.length));
        await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
        await scan();

        await wizardButton(page, "data.import.next.import").click();
        await expect(stepHeading(page, "data.import.step3.title.done")).toBeVisible();
        await expect(resultFigure(page, "data.import.result.created")).toHaveText(String(web.length));
        await expect(resultFigure(page, "data.import.result.failed")).toHaveText(String(links.length - web.length));
        await scan();

        const exported = await exportFile(page, "netscape");
        expect(exported.name).toMatch(/^slugbase-export-\d{4}-\d{2}-\d{2}\.html$/);
        const out = linksOfBookmarkFile(exported.text);
        const missing = web.filter(
          (link) => !out.some((entry) => new URL(entry.url).href === new URL(link.url).href && (link.title === "" || entry.title === link.title)),
        );
        expect(missing, `links of the ${browser} file that the browser file leaves out or changes`).toEqual([]);
        // What the import refused (a bookmarklet, a browser page, a query) is no bookmark and is not written.
        for (const link of links.filter((entry) => !isWebAddress(entry.url))) {
          expect(
            out.map((entry) => entry.url),
            `the address ${link.url} that is no web address`,
          ).not.toContain(link.url);
        }
        await scan();
      });
    }

    await test.step("tells why a file of a newer version, a file over 5 MiB and a file of another type are turned away", async () => {
      await wizardButton(page, "data.import.next.another").click();
      await expect(stepHeading(page, "data.import.step1.title")).toBeVisible();

      await chooseFile(page, { name: "newer.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "slugbase-export", version: 2, bookmarks: [] })) });
      await wizardButton(page, "data.import.next.preview").click();
      await expect(page.getByText(en("data.import.error.newerVersion"), { exact: true })).toBeVisible();
      await expect(stepHeading(page, "data.import.step1.title")).toBeVisible();
      await expect(page.getByRole("button", { name: en("data.import.retry"), exact: true })).toBeVisible();
      await scan();

      await chooseFile(page, { name: "big.json", mimeType: "application/json", buffer: Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x20) });
      await expect(page.getByText(en("data.import.error.tooLarge"), { exact: true })).toBeVisible();
      await expect(page.getByText(en("data.import.error.newerVersion"), { exact: true })).toHaveCount(0);
      await expect(wizardButton(page, "data.import.next.preview")).toBeDisabled();
      await scan();

      await chooseFile(page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a bookmark file") });
      await expect(page.getByText(en("data.import.error.unsupported"), { exact: true })).toBeVisible();
      await expect(page.getByText(en("data.import.error.tooLarge"), { exact: true })).toHaveCount(0);
      await expect(wizardButton(page, "data.import.next.preview")).toBeDisabled();
      await scan();
    });
  });
});
