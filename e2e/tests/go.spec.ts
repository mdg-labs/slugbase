import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { APIResponse, Dialog, Locator, Page, PlaywrightWorkerArgs, Response } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { DESTINATION_HEADING, startDestination, type Destination } from "../support/destination.ts";
import { appOrigin, STORAGE_STATE } from "../support/environment.ts";
import { WORKSPACE_NAME } from "../support/instance.ts";
import { createWorkspace, type CreatedWorkspace } from "../support/instance-admin.ts";
import { invitationLink, waitForMail } from "../support/mailpit.ts";
import { expect, test } from "../support/test.ts";

// The slug and /go journey (doc 08 sections 5.1 and 5.2, doc 02 sections 6.1, 6.2 and 6.4, Q26, Q39, Q43), after the first-run
// setup (tests/first-run.setup.ts): a member gives a bookmark a slug in the modal and /go/<slug> forwards to a destination served from
// the machine that runs the browser; a visitor without a session is sent to sign in and lands on the destination after it; a path or a
// query after the slug is a page that does not exist and forwards nowhere; a slug that nobody has offers to create a bookmark, and the
// bookmark then forwards; a slug that only a second workspace has is offered as "Found in" and the switch lands on the destination; a
// choice stored through the API is listed on the Forwarding page and can be removed; and a bookmark with a javascript: address cannot
// be created through the modal or the API. Each page and overlay it reaches is scanned for WCAG 2.2 AA violations (tests/axe.spec.ts,
// support/axe.ts), and the journey runs on a desktop screen in each engine and on a 390 px wide phone in Chromium (Q39). Every text is
// read from the catalogs of packages/web.
//
// The owner of the instance signed in with a password nobody keeps, and a switch of workspace is kept in the session, which the
// other journeys share. The journey therefore invites an address of its own, accepts the invitation as a new account with a password
// made up for the run, and acts as that member: its bookmarks, its second workspace, its choices and its sessions are its own, and
// the account's preferences lock of the other journeys is not needed. The member leaves the workspace again when the journey ends.
// The password is never printed.

const PHONE = { width: 390, height: 844 };

type Playwright = PlaywrightWorkerArgs["playwright"];

const NO_SESSION = { cookies: [], origins: [] };

const BOOKMARKS = "/api/v1/bookmarks";

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

const AUTH_DIRECTORY = dirname(STORAGE_STATE);

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not set up before the journey`);
  }
  return value;
}

async function expectStatus(response: APIResponse | Response, status: number, what: string): Promise<void> {
  // The body of a response the page has moved on from, and an empty one, say nothing.
  const body = await response.text().catch(() => "");
  expect(response.status(), `${what} answered ${String(response.status())}: ${body}`).toBe(status);
}

function mutation(data?: unknown): { headers: Record<string, string>; data?: unknown } {
  // A mutation must come from the origin the server is configured with, and be JSON with or without a body.
  return { headers: { origin: appOrigin(), "content-type": "application/json" }, ...(data === undefined ? {} : { data }) };
}

interface Member {
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
}

/**
 * The owner invites an address, the mail is read from Mailpit, and the address accepts as a new account with a password of its
 * own. The session of that account is kept in `statePath`, as the state the journey starts from.
 */
async function provisionMember(playwright: Playwright, token: string, statePath: string): Promise<Member> {
  const email = `go-${token}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const options = { baseURL: appOrigin(), ignoreHTTPSErrors: true } as const;
  const owner = await playwright.request.newContext({ ...options, storageState: STORAGE_STATE });
  // The context inherits the storage state of the project unless it is given one: this one starts without a session.
  const visitor = await playwright.request.newContext({ ...options, storageState: NO_SESSION });
  try {
    await expectStatus(await owner.post("/api/v1/invitations", mutation({ email, role: "member" })), 201, "POST /api/v1/invitations");
    const mail = await waitForMail(email);
    const invitation = new URL(invitationLink(mail.text, appOrigin())).pathname.slice("/invite/".length);
    const accepted = await visitor.post("/api/v1/invitations/accept", mutation({ token: invitation, displayName: `Go ${token}`, password }));
    await expectStatus(accepted, 201, "POST /api/v1/invitations/accept");
    // The member's language is the account's, so it is set rather than left to what the sign-up chose.
    await expectStatus(await visitor.patch("/api/v1/me", mutation({ locale: "en" })), 200, "PATCH /api/v1/me");
    const me = (await (await visitor.get("/api/v1/me")).json()) as { account?: { id?: unknown } };
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

async function removeMember(playwright: Playwright, member: Member): Promise<void> {
  const owner = await playwright.request.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, storageState: STORAGE_STATE });
  try {
    // The member's bookmarks in the workspace go with the membership.
    await expectStatus(await owner.delete(`/api/v1/members/${member.accountId}`, mutation({ content: "delete" })), 200, "DELETE /api/v1/members/{accountId}");
  } finally {
    await owner.dispose();
  }
}

/** The instance admin (the owner of the instance) creates a workspace that the member owns. */
async function createWorkspaceFor(playwright: Playwright, member: Member, name: string): Promise<CreatedWorkspace> {
  const owner = await playwright.request.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, storageState: STORAGE_STATE });
  try {
    return await createWorkspace(owner, name, { ownerAccountId: member.accountId });
  } finally {
    await owner.dispose();
  }
}

function isCreate(response: Response): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname === BOOKMARKS;
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

function listHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: en("bookmarks.page.title") });
}

function createModal(page: Page): Locator {
  return page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
}

/** The button of the toolbar; the empty list has a second one of its own, which comes later in the page. */
function newBookmark(page: Page): Locator {
  return page.getByRole("button", { name: en("bookmarks.new"), exact: true }).first();
}

function signInCard(page: Page): Locator {
  return page.getByRole("region", { name: en("login.title") });
}

for (const { name, viewport } of [
  { name: "on a desktop screen", viewport: undefined },
  { name: "on a 390 px wide phone", viewport: PHONE },
] as const) {
  test.describe(`go journey ${name}`, () => {
    if (viewport !== undefined) {
      test.use({ viewport });
      // The sign-in attempts of the stack are limited per client address (10 a minute, doc 04 section 7), and the journey signs in
      // once, so the phone-size run is Chromium's.
      test.skip(({ browserName }) => browserName !== "chromium", "the phone-size run is Chromium's");
    }

    const token = randomBytes(4).toString("hex");
    const statePath = join(AUTH_DIRECTORY, `go-${token}.json`);
    let destination: Destination | undefined;
    let member: Member | undefined;

    test.use({ storageState: statePath });

    test.beforeAll(async ({ playwright }) => {
      destination = await startDestination();
      member = await provisionMember(playwright, token, statePath);
    });

    test.afterAll(async ({ playwright }) => {
      try {
        await destination?.close();
        if (member !== undefined) {
          await removeMember(playwright, member);
        }
      } finally {
        rmSync(statePath, { force: true });
      }
    });

    test("sets a slug and forwards, signs in on the way, finds no bookmark, switches workspace and lists a remembered choice", async ({ page, app, playwright }) => {
      test.setTimeout(180_000);
      const target = required(destination, "the destination");
      const account = required(member, "the member");

      // A toast of an earlier step is not part of the page or the dialog under test, so each scan waits for them to go, and the pointer is
      // moved off the stack they rise in, which a toast does not leave while it rests on it.
      const scan = async (): Promise<void> => {
        await page.mouse.move(0, 0);
        await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
        await app.scan();
      };
      const fits = async (): Promise<void> => {
        await expectNoSidewaysScroll(page);
      };

      const dialogs: string[] = [];
      page.on("dialog", (dialog: Dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const slug = `journey-${token}`;
      const path = `/arrived/${token}`;
      const destinationUrl = target.url(path);

      /** Fills the open create modal with an address and a title, and saves it; returns the bookmark the server stored. */
      const saveBookmark = async (dialog: Locator, url: string, title: string): Promise<{ id: string; slug: string | null; forwarding: boolean }> => {
        await dialog.getByLabel(en("bookmarks.modal.url.label"), { exact: true }).fill(url);
        await dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true }).fill(title);
        const answered = page.waitForResponse(isCreate);
        await dialog.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }).click();
        const response = await answered;
        await expectStatus(response, 201, "POST /api/v1/bookmarks");
        return (await response.json()) as { id: string; slug: string | null; forwarding: boolean };
      };

      /** Opens /go/<slug> as the address bar does and waits for the destination to arrive. */
      const arrives = async (address: string, at: string): Promise<void> => {
        await page.goto(address);
        await expect(page).toHaveURL(target.url(at));
        await expect(page.getByRole("heading", { level: 1, name: DESTINATION_HEADING })).toBeVisible();
        await scan();
      };

      await test.step("gives a bookmark a slug in the modal and /go/<slug> forwards to the destination", async () => {
        await app.visit("/bookmarks", listHeading(page));
        await newBookmark(page).click();
        const dialog = createModal(page);
        await expect(dialog).toBeVisible();
        await dialog.getByLabel(en("bookmarks.modal.slug.label"), { exact: true }).fill(slug);
        // The slug is asked about once it has stood still, and a free one says so; forwarding turns on with the slug.
        await expect(dialog.getByText(en("bookmarks.modal.slug.available"), { exact: true })).toBeVisible();
        await expect(dialog.getByRole("switch", { name: en("bookmarks.modal.forwarding.label"), exact: true })).toBeChecked();
        await expect(dialog.getByRole("textbox", { name: en("bookmarks.modal.slug.address.label"), exact: true })).toHaveValue(`${appOrigin()}/go/${slug}`);
        await expectWithinScreen(page, dialog);
        await fits();
        await scan();

        const stored = await saveBookmark(dialog, destinationUrl, `Journey ${token}`);
        expect(stored.slug).toBe(slug);
        expect(stored.forwarding).toBe(true);
        await expect(dialog).toHaveCount(0);

        await arrives(`/go/${slug}`, path);
        expect(target.requests(), "what the destination was asked for").toEqual([path]);
      });

      await test.step("sends a visitor without a session to sign in, and the sign-in lands on the destination", async () => {
        await page.context().clearCookies();
        await page.goto(`/go/${slug}`);
        await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=(/|%2F)go(/|%2F)${slug}$`));
        await expect(signInCard(page)).toBeVisible();
        await fits();
        await scan();
        const card = signInCard(page);
        await card.getByLabel(en("login.email.label"), { exact: true }).fill(account.email);
        await card.getByLabel(en("login.password.label"), { exact: true }).fill(account.password);
        const arrived = page.waitForURL(destinationUrl);
        await card.getByRole("button", { name: en("login.submit"), exact: true }).click();
        await arrived;
        await expect(page.getByRole("heading", { level: 1, name: DESTINATION_HEADING })).toBeVisible();
        await scan();
        expect(target.requests(), "what the destination was asked for").toEqual([path, path]);
      });

      await test.step("shows the page that does not exist for a path or a query after the slug, and forwards nowhere", async () => {
        const before = target.requests().length;
        for (const address of [`/go/${slug}/more/path`, `/go/${slug}?x=1`]) {
          await page.goto(address);
          await expect(page).toHaveURL(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          await expect(page.getByRole("heading", { name: en("errorPage.notFound.title"), exact: true })).toBeVisible();
          await fits();
          await scan();
        }
        expect(target.requests().length, "the destination was asked for nothing more").toBe(before);
      });

      const unknown = `nobody-${token}`;
      const createdPath = `/created/${token}`;

      await test.step("offers to create a bookmark for a slug nobody has, and the bookmark then forwards", async () => {
        await page.goto(`/go/${unknown}`);
        await expect(page.getByRole("heading", { level: 1, name: en("go.notFound.title", { slug: unknown, workspace: WORKSPACE_NAME }) })).toBeVisible();
        // The slug is in no other workspace of the member, so nothing is offered to switch to.
        await expect(page.getByRole("button", { name: /^Found in:/ })).toHaveCount(0);
        await fits();
        await scan();

        await page.getByRole("link", { name: en("go.notFound.create"), exact: true }).click();
        const dialog = createModal(page);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel(en("bookmarks.modal.slug.label"), { exact: true })).toHaveValue(unknown);
        await expect(dialog.getByText(en("bookmarks.modal.slug.available"), { exact: true })).toBeVisible();
        await expectWithinScreen(page, dialog);
        await scan();

        const stored = await saveBookmark(dialog, target.url(createdPath), `Created ${token}`);
        expect(stored.slug).toBe(unknown);
        expect(stored.forwarding).toBe(true);
        await expect(dialog).toHaveCount(0);

        await arrives(`/go/${unknown}`, createdPath);
      });

      await test.step("lists a choice remembered through the API on the Forwarding page and removes it", async () => {
        await app.visit("/bookmarks", listHeading(page));
        const mine = (await (await page.request.post("/api/v1/go/resolve", mutation({ slug }))).json()) as { result?: string; bookmark?: { id?: string } };
        expect(mine.result, "what the slug resolves to for its owner").toBe("single");
        const bookmarkId = required(mine.bookmark?.id, "the bookmark the slug resolves to");
        await expectStatus(await page.request.post("/api/v1/go/choose", mutation({ slug, bookmarkId, remember: true })), 200, "POST /api/v1/go/choose");
        const remembered = (await (await page.request.get("/api/v1/me/go-preferences")).json()) as { items: { slug: string; bookmarkId: string }[] };
        expect(remembered.items.map((item) => item.slug)).toEqual([slug]);

        await app.visit("/forwarding", page.getByRole("heading", { level: 1, name: en("forwarding.page.title"), exact: true }));
        const remove = page.getByRole("button", { name: en("forwarding.choices.removeFor", { slug }), exact: true });
        await expect(remove).toBeVisible();
        await expect(page.getByText(`/go/${slug}`, { exact: true }).first()).toBeVisible();
        await expect(page.getByRole("switch", { name: en("forwarding.slugs.switch", { slug }), exact: true })).toBeChecked();
        await fits();
        await scan();

        // The server is asked to forget the choice when the toast that offers the undo closes.
        const forgotten = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/v1/me/go-preferences/${slug}`, {
          timeout: 20_000,
        });
        await remove.click();
        await expect(remove).toHaveCount(0);
        await expect(page.getByText(en("forwarding.choices.removed", { slug }), { exact: true })).toBeVisible();
        await expect(page.getByText(en("forwarding.choices.empty.title"), { exact: true })).toBeVisible();
        await expectStatus(await forgotten, 204, "DELETE /api/v1/me/go-preferences/{slug}");
        const left = (await (await page.request.get("/api/v1/me/go-preferences")).json()) as { items: unknown[] };
        expect(left.items, "the remembered choices after the removal").toEqual([]);
        await scan();
      });

      await test.step("refuses a bookmark with a javascript: address in the modal and through the API", async () => {
        const hostile = "javascript:alert(document.domain)";
        const sent: string[] = [];
        const onRequest = (request: { method: () => string; url: () => string }): void => {
          if (request.method() === "POST" && new URL(request.url()).pathname === BOOKMARKS) {
            sent.push(request.url());
          }
        };
        page.on("request", onRequest);
        await app.visit("/bookmarks", listHeading(page));
        await newBookmark(page).click();
        const dialog = createModal(page);
        await expect(dialog).toBeVisible();
        await dialog.getByLabel(en("bookmarks.modal.url.label"), { exact: true }).fill(hostile);
        await dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true }).fill(`Script ${token}`);
        await dialog.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }).click();
        await expect(dialog.getByText(en("bookmarks.modal.url.error.notAllowed"), { exact: true })).toBeVisible();
        await expect(dialog).toBeVisible();
        await expectWithinScreen(page, dialog);
        await scan();
        page.off("request", onRequest);
        expect(sent, "requests to create the bookmark that the modal sent").toEqual([]);

        const refused = await page.request.post(BOOKMARKS, mutation({ url: hostile, title: `Script ${token}` }));
        expect(refused.status(), "POST /api/v1/bookmarks with a javascript: address").toBe(422);
        expect(((await refused.json()) as { code?: unknown }).code).toBe("url_not_allowed");

        // Neither of them stored anything, and nothing ran.
        const listed = (await (await page.request.get(`${BOOKMARKS}?limit=100`)).json()) as { items: { url: string }[] };
        expect(listed.items.filter((item) => item.url.toLowerCase().startsWith("javascript:")), "stored bookmarks with a javascript: address").toEqual([]);
        expect(dialogs, "scripts that ran during the journey").toEqual([]);

        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: en("bookmarks.modal.unsaved.discard"), exact: true }).click();
        await expect(dialog).toHaveCount(0);
      });

      await test.step("offers the workspace that has the slug, and the switch lands on the destination", async () => {
        const second = `Second ${token}`;
        const secondPath = `/second/${token}`;
        const onlySecond = `second-${token}`;
        const firstWorkspace = ((await (await page.request.get("/api/v1/me")).json()) as { activeWorkspaceId?: unknown }).activeWorkspaceId;
        expect(typeof firstWorkspace, "the member acts in a workspace").toBe("string");
        // CE does not let an ordinary account create a workspace: the instance admin makes one with the member as its owner.
        const secondId = (await createWorkspaceFor(playwright, account, second)).id;
        // The bookmark is made in the second workspace, where it is the only one with the slug, and the session goes back to the first.
        await expectStatus(await page.request.put("/api/v1/session/active-workspace", mutation({ workspaceId: secondId })), 204, "PUT /api/v1/session/active-workspace");
        await expectStatus(
          await page.request.post(BOOKMARKS, mutation({ url: target.url(secondPath), title: `Second ${token}`, slug: onlySecond })),
          201,
          "POST /api/v1/bookmarks in the second workspace",
        );
        await expectStatus(await page.request.put("/api/v1/session/active-workspace", mutation({ workspaceId: firstWorkspace })), 204, "PUT /api/v1/session/active-workspace");

        await page.goto(`/go/${onlySecond}`);
        await expect(page.getByRole("heading", { level: 1, name: en("go.notFound.title", { slug: onlySecond, workspace: WORKSPACE_NAME }) })).toBeVisible();
        const switchTo = page.getByRole("button", { name: en("go.notFound.switch", { workspace: second }), exact: true });
        await expect(switchTo).toBeVisible();
        await fits();
        await scan();
        // Nothing is forwarded across workspaces by itself.
        expect(target.requests()).not.toContain(secondPath);

        await switchTo.click();
        await expect(page).toHaveURL(target.url(secondPath));
        await expect(page.getByRole("heading", { level: 1, name: DESTINATION_HEADING })).toBeVisible();
        await scan();
        expect(target.requests()).toContain(secondPath);
      });

      expect(dialogs, "scripts that ran during the journey").toEqual([]);
    });
  });
}
