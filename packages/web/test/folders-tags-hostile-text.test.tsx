import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The name of a folder or a tag is a stranger's text (doc 10 T14, section 6): a member can name one `<img src=x onerror=...>`,
// and the name is shown on the Folders page, the Tags page, the sidebar, the chips of the bookmark filters, the bookmark
// modal and the forms and confirmations that name it. The failure scenario is a folder or a tag named with an `onerror`
// payload that is stored through the API and then listed: the page would hold an element the member never wrote and its
// handler would run. Each surface is rendered twice, with hostile names and with plain ones in their place, and the two
// documents must have the same elements with the same attribute names, so no element and no attribute came from a name; the
// name itself is found whole in a node that has no children.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Folder = ComponentTypes["schemas"]["Folder"];
type Tag = ComponentTypes["schemas"]["Tag"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";

/** The strings a stranger can put in a name, one per kind of attack and of script. */
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

const PLAIN = ["Plain name one", "Plain name two", "Plain name three", "Plain name four", "Plain name five", "Plain name six", "Plain name seven", "Plain name eight"] as const;

function folderId(n: number): string {
  return `0192f3a0-dddd-7000-8000-${String(n).padStart(12, "0")}`;
}

function tagId(n: number): string {
  return `0192f3a0-eeee-7000-8000-${String(n).padStart(12, "0")}`;
}

function folder(n: number, name: string): Folder {
  return {
    id: folderId(n),
    ownerId: OWNER,
    name,
    icon: "folder",
    color: 1,
    bookmarkCount: 2,
    version: 1,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
  };
}

function tag(n: number, name: string): Tag {
  return { id: tagId(n), name, bookmarkCount: 2, createdAt: "2026-10-01T08:00:00.000Z" };
}

function bookmark(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    ownerId: OWNER,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    title: `Bookmark ${String(n)}`,
    description: null,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: null,
    folders: [],
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function list(items: readonly unknown[]): unknown {
  return { items, nextCursor: null, total: items.length };
}

const foldersOf = (names: readonly string[]): Folder[] => names.map((name, index) => folder(index + 1, name));
const tagsOf = (names: readonly string[]): Tag[] => names.map((name, index) => tag(index + 1, name));

let alerts: unknown[] = [];

function use(scenario: Omit<Scenario, "name"> = {}): void {
  const fixtures = { listBookmarks: list([bookmark(1), bookmark(2)]), ...scenario.fixtures };
  server.use(...createHandlers(document_, { scenario: { name: "hostile-names", ...scenario, fixtures } }));
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  restoreWait();
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

const EXECUTABLE = "img:not([src^='/api/v1/favicons/']), script, iframe, object, embed, link, meta, base, form[action]";

// The address schemes a browser runs or renders as a document of their own, and the attributes that hold an address.
const SCRIPT_SCHEMES = ["javascript:", "vbscript:", "data:"];
const ADDRESS_ATTRIBUTES = new Set(["href", "src", "srcset", "action", "formaction", "xlink:href", "data", "poster", "background", "cite"]);

/** What no name may leave in the page: an element that loads or runs something, a handler attribute, a script address. */
function expectNothingInjected(): void {
  expect(Array.from(document.body.querySelectorAll(EXECUTABLE)).map((element) => element.outerHTML)).toEqual([]);
  const offending: string[] = [];
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    for (const name of element.getAttributeNames()) {
      const value = (element.getAttribute(name) ?? "").trim().toLowerCase();
      // A name is also the label of its controls and the value of its field, which are text and not an address.
      const scripted = ADDRESS_ATTRIBUTES.has(name) && SCRIPT_SCHEMES.some((scheme) => value.startsWith(scheme));
      if (name.startsWith("on") || scripted || name === "srcdoc") {
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
 * Renders a surface with the hostile names and with plain ones, and checks that the two documents have the same elements and
 * attribute names, that nothing executable is in the hostile one, and what `shown` says about it.
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

async function chooseAction(label: string, action: string): Promise<void> {
  await press(screen.getByRole("button", { name: label }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

function chipsOf(field: string): HTMLElement[] {
  const group = screen.getByRole("combobox", { name: field }).closest("[data-slot='multi-pick-chips']");
  return [...(group?.querySelectorAll<HTMLElement>("[data-slot='multi-pick-chip']") ?? [])];
}

/** Types into a combobox field, which opens its list and filters it. */
async function typeInto(input: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: text } });
    await Promise.resolve();
  });
}

describe("the Folders page with hostile names", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows every folder name in the table as text, with the actions of its row named after it", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listFolders: list(foldersOf(texts)) } });
        await openApp("/folders");
        await screen.findByRole("table", { name: "Folders" });
        await screen.findByRole("button", { name: `Actions for ${texts[0] ?? ""}` });
      },
      (texts) => {
        const table = screen.getByRole("table", { name: "Folders" });
        for (const text of texts) {
          expectShownAsText(text);
          expect(within(table).getByRole("button", { name: `Actions for ${text}` })).toBeDefined();
        }
      },
    );
  });

  it("names the folder as text in the confirmation of its deletion", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listFolders: list(foldersOf(texts)) } });
        await openApp("/folders");
        await screen.findByRole("table", { name: "Folders" });
        await chooseAction(`Actions for ${texts[0] ?? ""}`, "Delete");
        await screen.findByRole("alertdialog", { name: `Delete “${texts[0] ?? ""}”?` });
      },
      (texts) => {
        const confirm = screen.getByRole("alertdialog", { name: `Delete “${texts[0] ?? ""}”?` });
        expect(within(confirm).getByRole("heading", { name: `Delete “${texts[0] ?? ""}”?` }).children).toHaveLength(0);
      },
      HOSTILE.slice(0, 2),
    );
  });

  it("holds the name in the field of the rename form as typed and shows it as text in the preview", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listFolders: list(foldersOf(texts)) } });
        await openApp("/folders");
        await screen.findByRole("table", { name: "Folders" });
        await chooseAction(`Actions for ${texts[0] ?? ""}`, "Rename");
        await screen.findByRole("dialog", { name: "Rename folder" });
      },
      (texts) => {
        const dialog = screen.getByRole("dialog", { name: "Rename folder" });
        expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe(texts[0]);
        const preview = dialog.querySelector("[data-slot='folder-preview']");
        expect(preview?.textContent).toBe(texts[0]);
        expectShownAsText(texts[0] ?? "");
      },
      HOSTILE.slice(0, 2),
    );
  });
});

describe("the Tags page with hostile names", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows every tag name in the table as text", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) } });
        await openApp("/tags");
        await screen.findByRole("table", { name: "Tags" });
        await screen.findByRole("button", { name: `Actions for ${texts[0] ?? ""}` });
      },
      (texts) => {
        const table = screen.getByRole("table", { name: "Tags" });
        for (const text of texts) {
          expectShownAsText(text);
          expect(within(table).getByRole("button", { name: `Actions for ${text}` })).toBeDefined();
        }
      },
    );
  });

  it("shows the selected tag's name as text in the heading of its preview", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) } });
        await openApp(`/tags?tag=${tagId(1)}`);
        await screen.findByRole("heading", { level: 2, name: texts[0] ?? "" });
        await screen.findByRole("table", { name: `Newest bookmarks tagged ${texts[0] ?? ""}` });
      },
      (texts) => {
        const heading = screen.getByRole("heading", { level: 2, name: texts[0] ?? "" });
        expect(heading.children).toHaveLength(0);
        expect(heading.textContent).toBe(texts[0]);
        expectShownAsText(texts[0] ?? "");
      },
    );
  });

  it("names the tag as text in the confirmation of its deletion", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) } });
        await openApp("/tags");
        await screen.findByRole("table", { name: "Tags" });
        await chooseAction(`Actions for ${texts[0] ?? ""}`, "Delete");
        await screen.findByRole("alertdialog", { name: `Delete “${texts[0] ?? ""}”?` });
      },
      (texts) => {
        const confirm = screen.getByRole("alertdialog", { name: `Delete “${texts[0] ?? ""}”?` });
        expect(within(confirm).getByRole("heading", { name: `Delete “${texts[0] ?? ""}”?` }).children).toHaveLength(0);
      },
      HOSTILE.slice(0, 2),
    );
  });

  it("holds the name in the field of the rename form as typed", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) } });
        await openApp("/tags");
        await screen.findByRole("table", { name: "Tags" });
        await chooseAction(`Actions for ${texts[0] ?? ""}`, "Rename");
        await screen.findByRole("dialog", { name: "Rename tag" });
      },
      (texts) => {
        const dialog = screen.getByRole("dialog", { name: "Rename tag" });
        expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe(texts[0]);
      },
      HOSTILE.slice(0, 2),
    );
  });

  it("names both tags as text in the confirmation of a merge", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) }, statuses: { renameTag: 409 } });
        await openApp("/tags");
        await screen.findByRole("table", { name: "Tags" });
        await chooseAction(`Actions for ${texts[0] ?? ""}`, "Rename");
        const dialog = await screen.findByRole("dialog", { name: "Rename tag" });
        const field = within(dialog).getByLabelText<HTMLInputElement>("Name");
        // Base UI focuses the first field after opening; changing it earlier makes data-touched depend on timing.
        await waitFor(() => {
          expect(document.activeElement).toBe(field);
        });
        await act(async () => {
          fireEvent.change(field, { target: { value: texts[1] ?? "" } });
          await Promise.resolve();
        });
        await press(within(dialog).getByRole("button", { name: "Save" }));
        await screen.findByRole("alertdialog", { name: `Merge into “${texts[1] ?? ""}”?` });
      },
      (texts) => {
        const confirm = screen.getByRole("alertdialog", { name: `Merge into “${texts[1] ?? ""}”?` });
        expect(within(confirm).getByRole("heading", { name: `Merge into “${texts[1] ?? ""}”?` }).children).toHaveLength(0);
        expect(confirm.textContent).toContain(`“${texts[0] ?? ""}” is deleted`);
        expect(confirm.textContent).toContain(`tagged “${texts[1] ?? ""}” instead`);
      },
      HOSTILE.slice(0, 2),
    );
  });
});

describe("the sidebar with hostile folder names", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows every folder name in the Folders section as text, in a link that filters by the folder", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listFolders: list(foldersOf(texts)) } });
        await openApp("/bookmarks");
        await within(sidebar()).findByRole("link", { name: texts[0] ?? "" });
      },
      (texts) => {
        texts.forEach((text, index) => {
          const link = within(sidebar()).getByRole("link", { name: text });
          expect(link.getAttribute("href")).toBe(`/bookmarks?folderId=${folderId(index + 1)}`);
          expect(link.textContent).toBe(text);
          expect(Array.from(link.children).every((child) => child.textContent === "" || child.children.length === 0)).toBe(true);
        });
      },
    );
  });
});

describe("the filter chips with hostile names", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the chip of a folder filter as text, with the button that takes it off named after it", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listFolders: list(foldersOf(texts)) } });
        await openApp(`/bookmarks?folderId=${folderId(1)}`);
        await screen.findByRole("list", { name: "Active filters" });
        await screen.findByText(`Folder: ${texts[0] ?? ""}`);
      },
      (texts) => {
        const chips = screen.getByRole("list", { name: "Active filters" });
        const chip = within(chips).getByText(`Folder: ${texts[0] ?? ""}`);
        expect(chip.children).toHaveLength(0);
        expect(within(chips).getByRole("button", { name: `Remove filter: Folder: ${texts[0] ?? ""}` })).toBeDefined();
        expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe(texts[0]);
      },
      HOSTILE.slice(0, 2),
    );
  });

  it("shows the chip of every tag filter as text, with the button that takes it off named after it", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) } });
        await openApp(`/bookmarks?${texts.map((_text, index) => `tag=${tagId(index + 1)}`).join("&")}`);
        await screen.findByRole("button", { name: `Remove tag ${texts[0] ?? ""}` });
      },
      (texts) => {
        const chips = chipsOf("Tags");
        expect(chips.map((chip) => chip.textContent)).toEqual([...texts]);
        for (const chip of chips) {
          expect(chip.querySelectorAll("span:not([aria-hidden])")).toHaveLength(1);
        }
        for (const text of texts) {
          expect(screen.getByRole("button", { name: `Remove tag ${text}` })).toBeDefined();
        }
      },
    );
  });

  it("lists the tags of the filter as text options", async () => {
    await surface(
      async (texts) => {
        use({ fixtures: { listTags: list(tagsOf(texts)) } });
        await openApp("/bookmarks");
        const input = await screen.findByRole("combobox", { name: "Tags" });
        await typeInto(input, "");
        await screen.findByRole("option", { name: texts[0] ?? "", hidden: true });
      },
      (texts) => {
        for (const text of texts) {
          expect(screen.getByRole("option", { name: text, hidden: true }).textContent).toBe(text);
        }
      },
    );
  });
});

describe("the bookmark modal with hostile folder and tag names", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const carried = (texts: readonly string[]): Bookmark =>
    bookmark(1, {
      folders: texts.map((name, index) => ({ id: folderId(index + 1), name, icon: "folder", color: 1 })),
      tags: texts.map((name, index) => ({ id: tagId(index + 1), name })),
    });

  it("shows the folders and tags of the bookmark as chips of text, with their buttons named after them", async () => {
    await surface(
      async (texts) => {
        const shown = carried(texts);
        use({ fixtures: { getBookmark: shown, listFolders: list(foldersOf(texts)), listTags: list(tagsOf(texts)) } });
        await openApp(`/bookmarks?bookmark=${shown.id}`);
        const dialog = await screen.findByRole("dialog", { name: "Edit bookmark" });
        await waitFor(() => {
          expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe(shown.url);
        });
        await within(dialog).findAllByRole("button", { name: `Remove ${texts[0] ?? ""}`, hidden: true });
      },
      (texts) => {
        const dialog = screen.getByRole("dialog", { name: "Edit bookmark" });
        for (const field of ["Folders", "Tags"]) {
          const group = within(dialog).getByRole("combobox", { name: field }).closest("[data-slot='multi-pick-chips']");
          const chips = [...(group?.querySelectorAll("[data-slot='multi-pick-chip']") ?? [])];
          expect(chips.map((chip) => chip.textContent)).toEqual([...texts]);
        }
        for (const text of texts) {
          expect(within(dialog).getAllByRole("button", { name: `Remove ${text}`, hidden: true })).toHaveLength(2);
        }
      },
    );
  });

  it.each([
    ["folder", "Folders", "Create folder"],
    ["tag", "Tags", "Create tag"],
  ] as const)("offers a %s named with hostile text as text in the item that creates it", async (_kind, field, create) => {
    await surface(
      async (texts) => {
        use({ fixtures: { listFolders: list([]), listTags: list([]) } });
        await openApp("/bookmarks?new=1");
        const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
        await typeInto(within(dialog).getByRole("combobox", { name: field }), texts[0] ?? "");
        await screen.findByRole("option", { name: `${create} “${texts[0] ?? ""}”`, hidden: true });
      },
      (texts) => {
        const option = screen.getByRole("option", { name: `${create} “${texts[0] ?? ""}”`, hidden: true });
        expect(option.textContent).toBe(`${create} “${texts[0] ?? ""}”`);
        expectShownAsText(`${create} “${texts[0] ?? ""}”`);
      },
      HOSTILE.slice(0, 2),
    );
  });
});
