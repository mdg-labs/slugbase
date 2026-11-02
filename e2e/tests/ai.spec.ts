import { randomBytes } from "node:crypto";
import type { APIRequestContext, Locator, PlaywrightWorkerArgs, Response } from "@playwright/test";
import { clearStub, receivedByStub } from "../support/ai.ts";
import { COMPLETIONS_PATH } from "../support/ai-stub/stub.ts";
import { message } from "../support/catalog.ts";
import { appOrigin } from "../support/environment.ts";
import { WORKSPACE_NAME } from "../support/instance.ts";
import { ensureSharedMember } from "../support/member.ts";
import { SHARED_MEMBER_HOOK_TIMEOUT_MS, sharedMemberState } from "../support/member-shared.ts";
import { expect, test } from "../support/test.ts";

// The AI suggestions journey (doc 08 section 5.1, doc 02 section 14, doc 03 section 4, doc 10 T13 and T14), after the first-run setup
// (tests/first-run.setup.ts). The stack's server is configured with a stand-in for an OpenAI-compatible endpoint (e2e/compose.ai.yml),
// and a member opens the bookmark modal and presses Suggest: with every field empty the title, the slug and the tags are filled and
// the save names them; with a title and a slug typed already they stay and the suggestions are chips, of which the member takes one; a
// provider that fails leaves the form as it was and says so. The stand-in keeps what the server sent it, and the journey reads it back:
// the address, the language and the names of the member's own tags, and nothing else of the member, the workspace or the form.
//
// The journey acts as a member of its own (support/member.ts), so that the tags it sends are the ones it made and nothing else; it
// runs in Chromium alone (playwright.config.ts), as it counts the requests the stand-in received. The pages it visits have no metadata
// to read (the addresses end in .invalid), which is what lets the journey say what the request carried. Every text is read from the
// catalogs of packages/web.

const BOOKMARKS = "/api/v1/bookmarks";
const PROVIDER = "Example AI";

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

function isCreate(response: Response): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname === BOOKMARKS;
}

interface CompletionBody {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly response_format: unknown;
}

/** The data object of the user message of a request the stand-in received. */
function dataOf(body: CompletionBody): Record<string, unknown> {
  const content = body.messages[1]?.content ?? "";
  const block = /<bookmark_data>\n(.*)\n<\/bookmark_data>/s.exec(content)?.[1];
  expect(block, "the user message holds one data block").toBeDefined();
  return JSON.parse(block ?? "{}") as Record<string, unknown>;
}

test.describe("AI suggestions journey", () => {
  const token = randomBytes(4).toString("hex");
  const mineTag = `mine-${token}`;
  const otherTitle = `Other bookmark ${token}`;
  const otherDescription = `Private words ${token}`;
  const typedTitle = `My own title ${token}`;
  const typedSlug = `typed-${token}`;
  const first = { url: `https://ai-${token}.invalid/page`, host: `ai-${token}.invalid` };
  const second = { url: `https://ai2-${token}.invalid/page`, host: `ai2-${token}.invalid` };
  const third = { url: `https://fail-${token}.invalid/page`, host: `fail-${token}.invalid` };
  const ids = new Set<string>();

  test.use({ storageState: sharedMemberState("ai") });

  const asMember = (playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> =>
    playwright.request.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, storageState: sharedMemberState("ai") });

  test.beforeAll(async ({ playwright }) => {
    // The hook provisions the member, which takes longer than the 30 seconds of the default timeout.
    test.setTimeout(SHARED_MEMBER_HOOK_TIMEOUT_MS);
    await ensureSharedMember(playwright, "ai");
    await clearStub();
    // A bookmark of the member's own that the suggestions must not carry: its title and description stay in the workspace, its tag is the
    // one name the first request is allowed to name.
    const member = await asMember(playwright);
    try {
      const response = await member.post(BOOKMARKS, {
        headers: { origin: appOrigin(), "content-type": "application/json" },
        data: { url: `https://other-${token}.invalid/`, title: otherTitle, description: otherDescription, tagNames: [mineTag] },
      });
      const text = await response.text();
      expect(response.status(), `POST /api/v1/bookmarks answered ${text}`).toBe(201);
      ids.add((JSON.parse(text) as { id: string }).id);
    } finally {
      await member.dispose();
    }
  });

  test.afterAll(async ({ playwright }) => {
    const member = await asMember(playwright);
    const refused: number[] = [];
    try {
      for (const id of ids) {
        const removed = await member.delete(`${BOOKMARKS}/${id}`, { headers: { origin: appOrigin(), "content-type": "application/json" } });
        if (removed.status() !== 204 && removed.status() !== 404) {
          refused.push(removed.status());
        }
      }
    } finally {
      await member.dispose();
    }
    if (refused.length > 0) {
      throw new Error(`DELETE /api/v1/bookmarks/{id} answered ${refused.join(", ")} while the journey removed what it made`);
    }
  });

  test("fills the empty fields, offers chips for the edited ones, says so when the provider fails, and sends the provider nothing but the address, the language and the member's tag names", async ({
    page,
    app,
  }) => {
    test.setTimeout(150_000);
    page.on("response", (response) => {
      if (isCreate(response) && response.status() === 201) {
        void response.json().then((body: { id?: unknown }) => {
          if (typeof body.id === "string") {
            ids.add(body.id);
          }
        });
      }
    });

    const dialog = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
    const suggest = dialog.getByRole("button", { name: en("bookmarks.modal.suggest.label"), exact: true });
    const field = (key: string): Locator => dialog.getByLabel(en(key), { exact: true });
    const group = (key: string): Locator => dialog.getByRole("group", { name: en(key), exact: true });
    const removeTag = (name: string): Locator => dialog.getByRole("button", { name: en("bookmarks.modal.tags.remove", { name }), exact: true });
    // The page sends the bookmark as a stream, which the browser does not hand to the test, so the page's own fetch keeps a copy of the
    // body it sends to create a bookmark.
    await page.addInitScript(() => {
      const sent: string[] = [];
      Object.assign(window, { sentToCreateBookmark: sent });
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/bookmarks") {
          void request.clone().text().then((text) => sent.push(text));
        }
        return original(request);
      };
    });
    // A toast of an earlier step is not part of the page under test, and a toast does not go while the pointer rests on its stack.
    const scanList = async (): Promise<void> => {
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
      await app.scan();
    };
    const open = async (): Promise<void> => {
      await app.visit("/bookmarks?new=1", dialog);
      await expect(suggest).toBeVisible();
    };
    const save = async (): Promise<{ request: Record<string, unknown> }> => {
      const created = page.waitForResponse(isCreate);
      await dialog.getByRole("button", { name: en("bookmarks.modal.save"), exact: true }).click();
      const response = await created;
      expect(response.status(), "POST /api/v1/bookmarks").toBe(201);
      await expect(dialog).toHaveCount(0);
      const sent = await page.evaluate(() => (window as unknown as { sentToCreateBookmark: string[] }).sentToCreateBookmark);
      expect(sent, "the bodies the page sent to create a bookmark").toHaveLength(1);
      await scanList();
      return { request: JSON.parse(sent[0] ?? "null") as Record<string, unknown> };
    };

    await test.step("shows the action with the provider in its tooltip, and nothing about AI changes the form", async () => {
      await open();
      await suggest.hover();
      await expect(page.getByText(en("bookmarks.modal.suggest.tooltip.named", { provider: PROVIDER }))).toBeVisible();
      await expect(group("bookmarks.modal.suggest.chips.title")).toHaveCount(0);
      // The action is a control of the header and not the text that describes the dialog to assistive technology.
      await expect(dialog).toHaveAccessibleDescription("");
      await app.scan();
    });

    await test.step("fills a title, a slug and tags that are empty, and names them in the save", async () => {
      await field("bookmarks.modal.url.label").fill(first.url);
      await suggest.click();
      await expect(field("bookmarks.modal.title.label")).toHaveValue(`Stub title for ${first.host}`);
      await expect(field("bookmarks.modal.slug.label")).toHaveValue(`ai-${token}`);
      await expect(removeTag(mineTag)).toBeVisible();
      await expect(removeTag("stub-tag")).toBeVisible();
      await expect(group("bookmarks.modal.suggest.chips.title")).toHaveCount(0);
      await app.scan();

      const { request } = await save();
      expect(request).toMatchObject({ url: first.url, title: `Stub title for ${first.host}`, slug: `ai-${token}`, forwarding: true, tagNames: expect.arrayContaining(["stub-tag"]) });
      expect(request.aiFields, "the fields the save names as taken from a suggestion").toEqual(["title", "slug", "tags"]);
    });

    await test.step("keeps a title and a slug the member typed, offers chips for them, and names only what the member took", async () => {
      await open();
      await field("bookmarks.modal.url.label").fill(second.url);
      await field("bookmarks.modal.title.label").fill(typedTitle);
      await field("bookmarks.modal.slug.label").fill(typedSlug);
      await suggest.click();

      await expect(group("bookmarks.modal.suggest.chips.title").getByRole("button", { name: `Stub title for ${second.host}`, exact: true })).toBeVisible();
      await expect(group("bookmarks.modal.suggest.chips.slug").getByRole("button", { name: `ai2-${token}`, exact: true })).toBeVisible();
      await expect(removeTag(mineTag)).toBeVisible();
      await expect(field("bookmarks.modal.title.label")).toHaveValue(typedTitle);
      await expect(field("bookmarks.modal.slug.label")).toHaveValue(typedSlug);
      await app.scan();

      await group("bookmarks.modal.suggest.chips.title").getByRole("button", { name: `Stub title for ${second.host}`, exact: true }).click();
      await expect(field("bookmarks.modal.title.label")).toHaveValue(`Stub title for ${second.host}`);
      await expect(group("bookmarks.modal.suggest.chips.title")).toHaveCount(0);

      const { request } = await save();
      expect(request).toMatchObject({ url: second.url, title: `Stub title for ${second.host}`, slug: typedSlug });
      expect(request.aiFields, "the slug was typed and the chip for it was left").toEqual(["title", "tags"]);
    });

    await test.step("leaves the form as it is and says so when the provider fails", async () => {
      await open();
      await field("bookmarks.modal.url.label").fill(third.url);
      await field("bookmarks.modal.title.label").fill(typedTitle);
      // From the keyboard: the action stays the focus through the request and the answer, so the single-key shortcuts, which wait for a
      // focus outside every dialog, do not act behind the modal.
      await suggest.focus();
      await page.keyboard.press("Enter");

      await expect(dialog.getByText(en("bookmarks.modal.suggest.unavailable"), { exact: true })).toBeVisible();
      await expect(suggest).toBeFocused();
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: en("shortcuts.title"), exact: true })).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(field("bookmarks.modal.title.label")).toHaveValue(typedTitle);
      await expect(field("bookmarks.modal.slug.label")).toHaveValue("");
      await expect(group("bookmarks.modal.suggest.chips.title")).toHaveCount(0);
      await expect(suggest).toBeVisible();
      await app.scan();
    });

    await test.step("has sent the provider the address, the language and the member's own tag names, and nothing else", async () => {
      const received = await receivedByStub();
      expect(received.map(({ method, path }) => `${method} ${path}`), "what the provider was asked for").toEqual(Array(3).fill(`POST ${COMPLETIONS_PATH}`));
      expect(received.map((request) => dataOf(JSON.parse(request.body) as CompletionBody).url)).toEqual([first.url, second.url, third.url]);
      for (const [index, request] of received.entries()) {
        expect(request.headers, "the member's session and credentials are not forwarded").not.toContain("cookie");
        expect(request.headers).not.toContain("authorization");
        const body = JSON.parse(request.body) as CompletionBody;
        expect(Object.keys(body).sort()).toEqual(["messages", "model", "response_format"]);
        expect(body.model).toBe("stub-model");
        expect(body.messages.map(({ role }) => role)).toEqual(["system", "user"]);
        const data = dataOf(body);
        expect(Object.keys(data).sort(), "what the data block holds").toEqual(["description", "existing_tags", "language", "title", "url"]);
        expect(data).toMatchObject({ language: "en", title: null, description: null });
        // The first request names the one tag the member had, the others also the one the first save made.
        expect(data.existing_tags).toEqual(index === 0 ? [mineTag] : [mineTag, "stub-tag"]);
        for (const private_ of [otherTitle, otherDescription, typedTitle, typedSlug, WORKSPACE_NAME, "example.test"]) {
          expect(request.body, `the request holds ${private_}`).not.toContain(private_);
        }
      }
    });
  });
});
