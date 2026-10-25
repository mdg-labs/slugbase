import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The text of a bookmark is a stranger's text (doc 10 T14, section 6): a title or a description can hold markup, a script,
// a `javascript:` address, right-to-left text and emoji, and every surface that shows it shows it as text. The failure
// scenario is a bookmark titled with an `onerror` payload that is stored through the API and opened in the list, the
// table, the modal or a confirmation: the page would then hold an element the member never wrote and its handler would
// run. Each surface is rendered twice, with the hostile text and with plain text in its place, and the two documents must
// have the same elements with the same attribute names, so no element and no attribute came from the text; the text itself
// is found whole in a node that has no children.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";

/** The strings a stranger can put in a title or a description, one per kind of attack and of script. */
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '"><svg onload=alert(1)> <iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '" onmouseover="alert(1)" autofocus=\'x',
  "javascript:alert(document.cookie)",
  "&lt;b&gt;bold&lt;/b&gt; <b>bold</b> {{7*7}} ${7*7}",
  "مرحبا <b>بالعالم</b> ‮evil.exe ⁧שלום⁩",
  "🚀 <i>👨‍👩‍👧‍👦 🇩🇪 👍🏽</i> 🔥",
] as const;

const PLAIN = ["Plain title one", "Plain title two", "Plain title three", "Plain title four", "Plain title five", "Plain title six", "Plain title seven", "Plain title eight"] as const;

function bookmark(n: number, title: string, description: string | null, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    ownerId: OWNER,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    title,
    description,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: null,
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

/** The bookmarks of a list, one per text, with the same address, slug and pin whatever the text is. */
function bookmarksOf(texts: readonly string[]): Bookmark[] {
  return texts.map((text, index) => bookmark(index + 1, text, text, index % 2 === 0 ? { slug: `slug${String(index)}`, pinned: true } : {}));
}

function page(items: readonly Bookmark[]): unknown {
  return { items, nextCursor: null, total: items.length };
}

let alerts: unknown[] = [];

function use(scenario: Omit<Scenario, "name"> = {}): void {
  server.use(...createHandlers(document_, { scenario: { name: "hostile", ...scenario } }));
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  alerts = [];
  stubBrowserApis();
  stubMatchMedia();
  vi.stubGlobal("alert", (message: unknown) => {
    alerts.push(message);
  });
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApp(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

// The attributes Base UI sets while an overlay opens or closes; they say where a transition is, not what the text was.
const TRANSITION = new Set(["data-starting-style", "data-ending-style", "data-closed", "data-open", "data-instant"]);

/** Every element of the document and the names of its attributes, which is what text cannot add to. */
function shapeOf(): string[] {
  return Array.from(document.body.querySelectorAll("*")).map(
    (element) =>
      `${element.tagName.toLowerCase()}[${element
        .getAttributeNames()
        .filter((name) => !TRANSITION.has(name))
        .sort()
        .join(",")}]`,
  );
}

/** Lets the overlays that were opened or closed finish their transition, so the document is the one that stays. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

const EXECUTABLE = "img, script, iframe, object, embed, link, meta, base, form[action]";

// The address schemes a browser runs or renders as a document of their own.
const SCRIPT_SCHEMES = ["javascript:", "vbscript:", "data:"];

/** What no text may leave in the page: an element that loads or runs something, a handler attribute, a script address. */
function expectNothingInjected(): void {
  expect(Array.from(document.body.querySelectorAll(EXECUTABLE)).map((element) => element.outerHTML)).toEqual([]);
  const offending: string[] = [];
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    for (const name of element.getAttributeNames()) {
      const value = (element.getAttribute(name) ?? "").trim().toLowerCase();
      // The value of a field is the text typed into it, which is why it is not an address.
      const scripted = SCRIPT_SCHEMES.some((scheme) => value.startsWith(scheme));
      if (name.startsWith("on") || (name !== "value" && scripted) || name === "srcdoc") {
        offending.push(`${element.tagName.toLowerCase()}[${name}]`);
      }
    }
  }
  expect(offending).toEqual([]);
  expect(alerts).toEqual([]);
}

/** The text shown whole in a node of its own that holds nothing but text. */
function expectShownAsText(text: string): void {
  const nodes = screen.queryAllByText(text, { exact: true, ignore: "script, style, textarea" });
  expect(nodes.length, `"${text}" is shown as a text node`).toBeGreaterThan(0);
  for (const node of nodes) {
    expect(node.children).toHaveLength(0);
  }
}

/**
 * Renders a surface with the hostile texts and with plain ones, and checks that the two documents have the same
 * elements and attribute names, that nothing executable is in the hostile one, and what `shown` says about it.
 */
async function surface(
  open: (texts: readonly string[]) => Promise<void>,
  shown: (texts: readonly string[]) => void | Promise<void> = () => undefined,
  texts: readonly string[] = HOSTILE,
): Promise<void> {
  await open(PLAIN.slice(0, texts.length));
  await settle();
  const plain = shapeOf();
  cleanup();
  server.resetHandlers();
  await open(texts);
  await settle();
  expect(shapeOf()).toEqual(plain);
  expectNothingInjected();
  await shown(texts);
}

async function chooseAction(title: string, action: string): Promise<void> {
  await press(screen.getByRole("button", { name: `Actions for ${title}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

describe("the list of bookmarks with hostile text", () => {
  it("shows every title in the grid as text, the pin and slug beside it, and no description as markup", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listBookmarks: page(bookmarksOf(texts)) } });
        await openApp("/bookmarks");
        await screen.findByRole("link", { name: texts[0] });
      },
      (texts) => {
        for (const text of texts) {
          expectShownAsText(text);
          expect(screen.getByRole("checkbox", { name: `Select ${text}` })).toBeDefined();
          expect(screen.getByRole("button", { name: `Actions for ${text}` })).toBeDefined();
        }
        expect(screen.getByText("/go/slug0")).toBeDefined();
      },
    );
  });

  it("shows every title in the table as text", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listBookmarks: page(bookmarksOf(texts)) } });
        await openApp("/bookmarks?view=table");
        await screen.findByRole("table", { name: "Bookmarks" });
        await screen.findByRole("link", { name: texts[0] });
      },
      (texts) => {
        const table = screen.getByRole("table", { name: "Bookmarks" });
        for (const text of texts) {
          expectShownAsText(text);
          expect(within(table).getByRole("checkbox", { name: `Select ${text}` })).toBeDefined();
        }
      },
    );
  });

  it("does not follow an address that is not a web address, and shows its title as text", async () => {
    const hostile = [bookmark(1, "<img src=x onerror=alert(1)>", null, { url: "javascript:alert(1)", host: "alert(1)" })];
    use({ fixtures: { listBookmarks: page(hostile) } });
    await openApp("/bookmarks");

    await screen.findByRole("list", { name: "Bookmarks" });
    expect(screen.queryByRole("link", { name: "<img src=x onerror=alert(1)>" })).toBeNull();
    expectShownAsText("<img src=x onerror=alert(1)>");
    expectNothingInjected();
  });

  it("names the bookmark as text in the confirmation of its deletion", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listBookmarks: page(bookmarksOf(texts)) } });
        await openApp("/bookmarks");
        await screen.findByRole("link", { name: texts[0] });
        await chooseAction(texts[0] ?? "", "Delete");
        await screen.findByRole("alertdialog", { name: "Delete this bookmark?" });
      },
      (texts) => {
        const confirm = screen.getByRole("alertdialog", { name: "Delete this bookmark?" });
        expect(confirm.textContent).toContain(`“${texts[0] ?? ""}” is deleted for good`);
      },
      HOSTILE.slice(0, 2),
    );
  });

  it("states only a count in the bulk-delete confirmation while the selected bookmarks are hostile", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listBookmarks: page(bookmarksOf(texts)) } });
        await openApp("/bookmarks");
        await screen.findByRole("link", { name: texts[0] });
        await press(screen.getByRole("checkbox", { name: `Select ${texts[0] ?? ""}` }));
        await press(screen.getByRole("checkbox", { name: `Select ${texts[1] ?? ""}` }));
        await press(within(screen.getByRole("toolbar", { name: "Selected bookmarks" })).getByRole("button", { name: "Delete" }));
        await screen.findByRole("alertdialog", { name: "Delete 2 bookmarks?" });
      },
      (texts) => {
        const confirm = screen.getByRole("alertdialog", { name: "Delete 2 bookmarks?" });
        expect(confirm.textContent).toContain("Their slugs stop forwarding immediately.");
        // The open confirmation hides the page behind it from the accessibility tree.
        expect(screen.getByRole("checkbox", { name: `Select ${texts[0] ?? ""}`, hidden: true }).getAttribute("aria-checked")).toBe("true");
        expectShownAsText(texts[0] ?? "");
      },
      HOSTILE.slice(0, 2),
    );
  });

  it("opens the hostile bookmark's page in the list without running anything, whatever the sort", async () => {
    use({ fixtures: { listBookmarks: page(bookmarksOf(HOSTILE)) } });
    await openApp("/bookmarks?sort=title_asc&view=table");

    await screen.findByRole("table", { name: "Bookmarks" });
    await screen.findByRole("link", { name: HOSTILE[0] });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expectNothingInjected();
  });
});

describe("the bookmark modal with hostile text", () => {
  it.each(HOSTILE.map((text, index) => [index, text] as const))("holds hostile text %i in the fields of an edit as typed, and nothing else", async (_index, text) => {
    const stored = bookmark(1, text, text);
    await surface(
      async (texts) => {
        const shown = bookmark(1, texts[0] ?? "", texts[0] ?? "");
        use({ fixtures: { getBookmark: shown, listBookmarks: page([]) } });
        await openApp(`/bookmarks?bookmark=${shown.id}`);
        const dialog = await screen.findByRole("dialog", { name: "Edit bookmark" });
        await waitFor(() => {
          expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe(shown.url);
        });
      },
      () => {
        const dialog = screen.getByRole("dialog", { name: "Edit bookmark" });
        expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe(stored.title);
        expect(within(dialog).getByLabelText<HTMLTextAreaElement>("Description").value).toBe(stored.description);
        expect(within(dialog).getByLabelText<HTMLTextAreaElement>("Description").children).toHaveLength(0);
      },
      [text],
    );
  });

  it.each(HOSTILE.map((text, index) => [index, text] as const))("names the duplicate with hostile text %i as text in the warning", async (_index, text) => {
    await surface(
      async (texts) => {
        const duplicate = bookmark(2, texts[0] ?? "", null, { url: "https://example.org/read", host: "example.org" });
        use({ fixtures: { listBookmarks: page([duplicate]), getBookmark: duplicate } });
        await openApp(`/?new=1&url=${encodeURIComponent(duplicate.url)}`);
        await screen.findByText("You already saved this address");
      },
      () => {
        const dialog = screen.getByRole("dialog", { name: "New bookmark" });
        expect(within(dialog).getByText(`“${text}” has the same address. You can still save this one.`).children).toHaveLength(0);
      },
      [text],
    );
  });

  it("names the bookmark as text in the confirmation of its deletion from the modal", async () => {
    const text = HOSTILE[0];
    await surface(
      async (texts) => {
        const shown = bookmark(1, texts[0] ?? "", null, { slug: "mail" });
        use({ fixtures: { getBookmark: shown, listBookmarks: page([]) } });
        await openApp(`/bookmarks?bookmark=${shown.id}`);
        const dialog = await screen.findByRole("dialog", { name: "Edit bookmark" });
        await waitFor(() => {
          expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe(shown.url);
        });
        await press(within(dialog).getByRole("button", { name: "Delete" }));
        await screen.findByRole("alertdialog", { name: "Delete this bookmark?" });
      },
      () => {
        const confirm = screen.getByRole("alertdialog", { name: "Delete this bookmark?" });
        expect(confirm.textContent).toContain(`“${text}” is deleted for good, and its slug stops forwarding immediately.`);
      },
      [text],
    );
  });
});
