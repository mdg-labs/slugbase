import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers, type OperationResolver } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { feedbackToast } from "@slugbase/ui/patterns";
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { SUGGEST_TIMEOUT_MS } from "../src/bookmarks/ai-suggest.ts";
import { ACCOUNT_BODY, CONFIG_BODY, WORKSPACE_ID, WORKSPACE_NAME, allowSlowRender, json, meOf, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Suggest action of the bookmark modal (doc 02 section 14, doc 03 section 4) against the handlers generated from openapi.json, through the app's own
// API client. The failure scenarios are an action shown where AI is off, opted out of, not granted or not known, a suggestion that overwrites a field the
// member filled, one for an address the field no longer holds, a slug that was taken since the answer was cached, a failure that changes a field or blocks
// the save, fields counted as taken from a suggestion after the member changed them, and the text of a suggestion rendered as markup.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Suggestion = ComponentTypes["schemas"]["AiSuggestion"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const DOCS = "https://example.com/docs";
const BLOG = "https://example.org/blog";
const PROVIDER = "Example AI";

const CREATED: Bookmark = {
  id: "0192f3a0-aaaa-7000-8000-000000000001",
  ownerId: "0192f3a0-bbbb-7000-8000-000000000001",
  url: DOCS,
  host: "example.com",
  title: "Example docs",
  description: null,
  slug: null,
  forwarding: false,
  pinned: false,
  openCount: 0,
  lastOpenedAt: null,
  folders: [],
  tags: [],
  version: 1,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
};

const TAG_ID = "0192f3a0-dddd-7000-8000-000000000001";

const SUGGESTION: Suggestion = { title: "Docs: the manual", slug: "manual", tags: ["reading", "Docs"], confidence: 0.8 };

interface World {
  ai: boolean;
  optOut: boolean;
  aiEnabled: boolean;
  entitled: boolean | "unreadable";
  workspace: "readable" | "unreadable";
  me: "readable" | "unreadable";
}

let world: World;
/** How many reads of each kind the handlers have refused since the test began. */
let refused = { me: 0, entitlements: 0, workspace: 0 };
let requests: unknown[] = [];
let created: unknown[] = [];
let updated: unknown[] = [];

function workspaceBody(): object {
  return { id: WORKSPACE_ID, name: WORKSPACE_NAME, role: "member", memberCount: 2, aiEnabled: world.aiEnabled, createdAt: "2026-09-01T08:00:00.000Z", version: 1 };
}

function entitlementsBody(): object {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": world.entitled === true,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 2, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function use(resolvers: Readonly<Record<string, OperationResolver>> = {}): void {
  server.use(
    ...createResolverHandlers(document_, {
      getApiConfig: () => json({ ...CONFIG_BODY, features: world.ai ? { ai: true, aiProvider: PROVIDER, mail: false } : { ai: false, mail: false } }),
      getMe: () => {
        if (world.me === "unreadable") {
          refused.me += 1;
          return problem(503, "unavailable", "req-me");
        }
        return json(meOf({ ...ACCOUNT_BODY, aiOptOut: world.optOut }));
      },
      getWorkspace: () => {
        if (world.workspace === "unreadable") {
          refused.workspace += 1;
          return problem(503, "unavailable", "req-ws");
        }
        return json(workspaceBody(), { headers: { ETag: '"1"' } });
      },
      getEntitlements: () => {
        if (world.entitled === "unreadable") {
          refused.entitlements += 1;
          return problem(503, "unavailable", "req-ent");
        }
        return json(entitlementsBody());
      },
      listTags: () => json({ items: [{ id: TAG_ID, name: "Reading", bookmarkCount: 1, createdAt: "2026-10-01T08:00:00.000Z" }], nextCursor: null, total: 1 }),
      fetchBookmarkMetadata: () => problem(502, "upstream_failed", "req-meta"),
      suggestBookmarkDetails: async (request) => {
        requests.push(await request.clone().json());
        return json(SUGGESTION);
      },
      createBookmark: async (request) => {
        created.push(await request.clone().json());
        return json(CREATED, { status: 201 });
      },
      updateBookmark: async (request) => {
        updated.push(await request.clone().json());
        return json(CREATED, { headers: { ETag: '"2"' } });
      },
      getBookmark: () => json({ ...CREATED, slug: "docs", forwarding: true }, { headers: { ETag: '"1"' } }),
      ...resolvers,
    }),
    ...createHandlers(document_, { scenario: { name: "bookmark-ai", fixtures: { listBookmarks: { items: [], nextCursor: null, total: 0 } } } }),
  );
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  world = { ai: true, optOut: false, aiEnabled: true, entitled: true, workspace: "readable", me: "readable" };
  refused = { me: 0, entitlements: 0, workspace: 0 };
  requests = [];
  created = [];
  updated = [];
  use();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

interface Held {
  readonly promise: Promise<Response>;
  readonly settle: (response: Response) => void;
}

function held(): Held {
  let settle: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    settle = done;
  });
  return { promise, settle };
}

async function openNew(extensions: WebExtension[] = [], search = "?new=1"): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/${search}`);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
  return screen.findByRole("dialog", { name: "New bookmark" });
}

async function openEdit(): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/?bookmark=${CREATED.id}`);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  return screen.findByRole("dialog", { name: "Edit bookmark" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await Promise.resolve();
  });
}

/** Types `name` into the tags field and takes its "Create tag" item. */
async function createTag(dialog: HTMLElement, name: string): Promise<void> {
  const input = await within(dialog).findByLabelText("Tags");
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  await type("Tags", name);
  await press(await screen.findByRole("option", { name: `Create tag “${name}”`, hidden: true }));
  await act(async () => {
    fireEvent.keyDown(input, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(document.querySelector("[data-slot='multi-pick-popup']")).toBeNull();
  });
}

/**
 * Waits until a read the handlers refuse has failed for good. A 503 is tried again twice, a second and two seconds apart, and the query holds its
 * last good answer and reports no error until the last try has failed, so a wait shorter than that checks the form while the read is still on its way.
 * The read has failed once the handlers have refused it as often as it is tried; a moment later the page has taken the last answer.
 */
async function untilFailed(read: keyof typeof refused): Promise<void> {
  await waitFor(
    () => {
      expect(refused[read]).toBeGreaterThanOrEqual(3);
    },
    { timeout: 12_000 },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

function suggestButton(dialog: HTMLElement): HTMLElement | null {
  return within(dialog).queryByRole("button", { name: "Suggest", hidden: true });
}

async function suggest(dialog: HTMLElement): Promise<void> {
  await press(await within(dialog).findByRole("button", { name: "Suggest", hidden: true }));
}

/** Closes the modal from its Cancel button and opens a new one with the `c` shortcut, as a member does between two visits to the form. */
async function reopen(dialog: HTMLElement): Promise<HTMLElement> {
  await press(within(dialog).getByRole("button", { name: "Cancel", hidden: true }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "New bookmark" })).toBeNull();
  });
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "c" });
    await Promise.resolve();
  });
  return screen.findByRole("dialog", { name: "New bookmark" });
}

/** Whether the list of the app's keyboard shortcuts is open. */
function shortcutSheet(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "Keyboard shortcuts" });
}

async function key(target: Element, name: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key: name });
    await Promise.resolve();
  });
}

function shimmers(dialog: HTMLElement): number {
  return dialog.querySelectorAll('[data-slot="skeleton"]').length;
}

function titleField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Title");
}

function slugField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Slug");
}

async function save(dialog: HTMLElement, sent: unknown[] = created): Promise<void> {
  await press(within(dialog).getByRole("button", { name: "Save", hidden: true }));
  await waitFor(() => {
    expect(sent).toHaveLength(1);
  });
}

describe("the Suggest action of the bookmark modal", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is shown with the provider the operator named in its tooltip where AI is configured, on, granted and not opted out of", async () => {
    const dialog = await openNew();

    const button = await within(dialog).findByRole("button", { name: "Suggest" });
    await act(async () => {
      fireEvent.pointerEnter(button);
      fireEvent.mouseEnter(button);
      fireEvent.focus(button);
      await Promise.resolve();
    });

    expect(await screen.findByText(/with Example AI\. It receives the address/, undefined, { timeout: 5000 })).toBeTruthy();
  });

  it("is absent, and nothing about AI is asked, where the server has no AI adapter", async () => {
    world.ai = false;
    const asked: string[] = [];
    use({
      getWorkspace: () => {
        asked.push("getWorkspace");
        return json(workspaceBody());
      },
    });
    const dialog = await openNew();
    await within(dialog).findByLabelText("URL");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(suggestButton(dialog)).toBeNull();
    expect(asked).toEqual([]);
  });

  it.each<[string, () => void, keyof typeof refused | undefined]>([
    ["the member opted out", () => (world.optOut = true), undefined],
    ["the workspace turned suggestions off", () => (world.aiEnabled = false), undefined],
    ["the workspace lacks the entitlement", () => (world.entitled = false), undefined],
    ["the entitlements cannot be read", () => (world.entitled = "unreadable"), "entitlements"],
    ["the workspace cannot be read", () => (world.workspace = "unreadable"), "workspace"],
  ])("is absent, not disabled, when %s", async (_name, change, unreadable) => {
    change();
    const dialog = await openNew();
    await within(dialog).findByLabelText("URL");
    await (unreadable === undefined ? new Promise((resolve) => setTimeout(resolve, 150)) : untilFailed(unreadable));

    expect(suggestButton(dialog)).toBeNull();
    expect(within(dialog).queryByText(/unavailable/i)).toBeNull();
  });

  it("offers the upgrade slot in its place where the workspace lacks the entitlement, and nothing where that is not known", async () => {
    const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <p>Upgrade for suggestions</p> } };
    world.entitled = false;
    const dialog = await openNew([upgrade]);

    expect(await within(dialog).findByText("Upgrade for suggestions")).toBeTruthy();
    expect(suggestButton(dialog)).toBeNull();
  });

  it("shows no upgrade hint when the entitlements could not be read", async () => {
    const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <p>Upgrade for suggestions</p> } };
    world.entitled = "unreadable";
    const dialog = await openNew([upgrade]);
    await within(dialog).findByLabelText("URL");
    await untilFailed("entitlements");

    expect(within(dialog).queryByText("Upgrade for suggestions")).toBeNull();
  });

  it("is not what describes the dialog, and its upgrade slot may hold a block element", async () => {
    const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <p>Upgrade for suggestions</p> } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    world.entitled = false;
    const dialog = await openNew([upgrade]);
    await within(dialog).findByText("Upgrade for suggestions");
    await act(async () => {
      await Promise.resolve();
    });
    errors.mockClear();
    world.entitled = true;
    const ready = await reopen(dialog);
    await within(ready).findByRole("button", { name: "Suggest" });

    for (const overlay of [dialog, ready]) {
      expect(overlay.getAttribute("aria-describedby")).toBeNull();
    }
    expect(ready.querySelector("[data-slot='dialog-description']")).toBeNull();
    expect(errors.mock.calls.map((call) => String(call[0]))).not.toContainEqual(expect.stringContaining("cannot be a descendant"));
  });

  it("keeps the focus on the Suggest button through the press and the answer, so a single key does nothing behind the modal", async () => {
    const answer = held();
    use({
      suggestBookmarkDetails: async (request) => {
        requests.push(await request.clone().json());
        return answer.promise;
      },
    });
    const dialog = await openNew();
    await type("URL", DOCS);
    const button = await within(dialog).findByRole("button", { name: "Suggest" });
    button.focus();

    await press(button);

    await waitFor(() => {
      expect(shimmers(dialog)).toBe(3);
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    await key(document.activeElement ?? document.body, "?");
    expect(shortcutSheet()).toBeNull();
    await press(button);
    expect(requests).toHaveLength(1);

    await act(async () => {
      answer.settle(json(SUGGESTION));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("data-loading")).toBe(false);
    await key(document.activeElement ?? document.body, "?");
    expect(shortcutSheet()).toBeNull();
  });

  it("holds the single-key shortcuts back behind the modal wherever focus is, and lets them act again once it has closed", async () => {
    const dialog = await openNew();
    await within(dialog).findByRole("button", { name: "Suggest" });

    // Focus on the page behind the modal, as it is after a save started from a field that is disabled meanwhile.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await key(document.body, "?");
    expect(shortcutSheet()).toBeNull();

    await press(within(dialog).getByRole("button", { name: "Cancel", hidden: true }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New bookmark" })).toBeNull();
    });
    await key(document.body, "?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("keeps the focus on the Suggest button when the request fails", async () => {
    use({ suggestBookmarkDetails: () => problem(502, "upstream_failed", "req-focus") });
    const dialog = await openNew();
    await type("URL", DOCS);
    const button = await within(dialog).findByRole("button", { name: "Suggest" });
    button.focus();

    await press(button);

    expect(await within(dialog).findByText("Suggestions unavailable")).toBeTruthy();
    expect(document.activeElement).toBe(button);
    await key(button, "?");
    expect(shortcutSheet()).toBeNull();
  });

  describe("when the action goes", () => {
    it.each([
      ["the instance has lost its adapter", () => problem(503, "ai_unavailable", "req-f1")],
      ["the toggle was turned off meanwhile", () => problem(403, "forbidden", "req-f2")],
    ])("moves focus into the dialog when the API refuses it because %s", async (_name, answer) => {
      use({ suggestBookmarkDetails: () => answer() });
      const dialog = await openNew();
      await type("URL", DOCS);
      const button = await within(dialog).findByRole("button", { name: "Suggest" });
      button.focus();

      await press(button);

      expect(await within(dialog).findByText("Suggestions unavailable")).toBeTruthy();
      expect(suggestButton(dialog)).toBeNull();
      expect(document.activeElement).toBe(dialog);
    });

    it("moves focus into the dialog when a read turns the toggle off", async () => {
      const dialog = await openNew();
      const button = await within(dialog).findByRole("button", { name: "Suggest" });
      button.focus();
      world.aiEnabled = false;

      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(suggestButton(dialog)).toBeNull();
      });
      expect(document.activeElement).toBe(dialog);
    });

    it("leaves focus where the member has moved it meanwhile", async () => {
      const dialog = await openNew();
      await within(dialog).findByRole("button", { name: "Suggest" });
      screen.getByLabelText("Title").focus();
      world.aiEnabled = false;

      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(suggestButton(dialog)).toBeNull();
      });
      expect(document.activeElement).toBe(titleField());
    });

    /** Turns the workspace toggle off elsewhere and lets the window regain focus, so the page reads it again and the action goes. */
    async function turnOffElsewhere(dialog: HTMLElement): Promise<void> {
      world.aiEnabled = false;
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(suggestButton(dialog)).toBeNull();
      });
    }

    it("leaves focus in the discard question standing over the form", async () => {
      const dialog = await openNew();
      await within(dialog).findByRole("button", { name: "Suggest" });
      await type("Title", "Unsaved");
      await press(within(dialog).getByRole("button", { name: "Cancel" }));
      const guard = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
      const keep = within(guard).getByRole("button", { name: "Keep editing" });
      await waitFor(() => {
        expect(document.activeElement).toBe(keep);
      });

      await turnOffElsewhere(dialog);

      expect(document.activeElement).toBe(keep);
    });

    it("leaves focus in the palette standing over the form", async () => {
      const dialog = await openNew();
      await within(dialog).findByRole("button", { name: "Suggest" });
      await act(async () => {
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        await Promise.resolve();
      });
      const palette = await screen.findByRole("dialog", { name: "Command palette" });
      const input = within(palette).getByRole("combobox", { name: "Search or run a command" });
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });

      await turnOffElsewhere(dialog);

      expect(document.activeElement).toBe(input);
    });

    describe("when the action went while an overlay stood over the form, and the overlay closes", () => {
      /** Whether focus is inside the form's dialog and not on the page behind it. */
      function focusIsIn(dialog: HTMLElement): boolean {
        return dialog.contains(document.activeElement) && document.activeElement !== document.body;
      }

      /** Opens the form, runs Suggest and holds its answer, so the action holds focus, and returns the dialog and what answers the run. */
      async function runningSuggest(): Promise<{ dialog: HTMLElement; button: HTMLElement; answer: Held }> {
        const answer = held();
        use({ suggestBookmarkDetails: () => answer.promise });
        const dialog = await openNew();
        await type("URL", DOCS);
        await type("Title", "Unsaved");
        const button = await within(dialog).findByRole("button", { name: "Suggest" });
        button.focus();
        await press(button);
        return { dialog, button, answer };
      }

      /** The API refuses the run that is under way: a 403 answers it and the action goes. */
      async function refuse(dialog: HTMLElement, answer: Held): Promise<void> {
        await act(async () => {
          answer.settle(problem(403, "forbidden", "req-close"));
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(suggestButton(dialog)).toBeNull();
        });
      }

      it.each([
        ["a refusal", "refuse"],
        ["a read", "read"],
      ])("moves focus into the dialog when the discard question closes after %s", async (_name, how) => {
        const { dialog, button, answer } = await runningSuggest();
        // The first Escape closes the tooltip that focus on the action opened.
        await key(button, "Escape");
        await key(button, "Escape");
        const guard = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
        const keep = within(guard).getByRole("button", { name: "Keep editing" });
        await waitFor(() => {
          expect(document.activeElement).toBe(keep);
        });

        await (how === "refuse" ? refuse(dialog, answer) : turnOffElsewhere(dialog));
        expect(document.activeElement).toBe(keep);
        await press(keep);

        await waitFor(() => {
          expect(screen.queryByRole("alertdialog")).toBeNull();
        });
        await waitFor(() => {
          expect(focusIsIn(dialog)).toBe(true);
        });
      });

      it.each([
        ["a refusal", "refuse"],
        ["a read", "read"],
      ])("moves focus into the dialog when the palette closes after %s", async (_name, how) => {
        const { dialog, button, answer } = await runningSuggest();
        await act(async () => {
          fireEvent.keyDown(button, { key: "k", ctrlKey: true });
          await Promise.resolve();
        });
        const palette = await screen.findByRole("dialog", { name: "Command palette" });
        const input = within(palette).getByRole("combobox", { name: "Search or run a command" });
        await waitFor(() => {
          expect(document.activeElement).toBe(input);
        });

        await (how === "refuse" ? refuse(dialog, answer) : turnOffElsewhere(dialog));
        expect(document.activeElement).toBe(input);
        await key(input, "Escape");

        await waitFor(() => {
          expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
        });
        await waitFor(() => {
          expect(focusIsIn(dialog)).toBe(true);
        });
      });

      it("ends inside the dialog, not on a toast that stands after it in the page, when the palette closes after the action went", async () => {
        const { dialog, button, answer } = await runningSuggest();
        await act(async () => {
          feedbackToast.success("Bookmark saved.");
          await Promise.resolve();
        });
        const toast = (await screen.findByText("Bookmark saved.")).closest<HTMLElement>("[role='dialog']");
        expect(toast?.getAttribute("aria-modal")).toBe("false");
        // The toast is the last of the dialogs in the page, so a fallback that took the last connected one would take it.
        let portal: HTMLElement | null = toast;
        while (portal !== null && portal.parentElement !== document.body) {
          portal = portal.parentElement;
        }
        if (toast === null || portal === null) {
          throw new Error("the toast is not in the page");
        }
        document.body.append(portal);
        expect(dialog.compareDocumentPosition(toast) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        await act(async () => {
          fireEvent.keyDown(button, { key: "k", ctrlKey: true });
          await Promise.resolve();
        });
        const palette = await screen.findByRole("dialog", { name: "Command palette" });
        const input = within(palette).getByRole("combobox", { name: "Search or run a command" });
        await waitFor(() => {
          expect(document.activeElement).toBe(input);
        });

        await refuse(dialog, answer);
        await key(input, "Escape");

        await waitFor(() => {
          expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
        });
        await waitFor(() => {
          expect(focusIsIn(dialog)).toBe(true);
        });
        expect(toast.contains(document.activeElement)).toBe(false);
      });

      it("gives focus back to where it was when the action stays, for the question and for the palette", async () => {
        const { answer } = await runningSuggest();
        const title = titleField();
        title.focus();
        await key(title, "Escape");
        const guard = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
        await press(within(guard).getByRole("button", { name: "Keep editing" }));
        await waitFor(() => {
          expect(screen.queryByRole("alertdialog")).toBeNull();
        });
        await waitFor(() => {
          expect(document.activeElement).toBe(title);
        });

        await act(async () => {
          fireEvent.keyDown(title, { key: "k", ctrlKey: true });
          await Promise.resolve();
        });
        await screen.findByRole("dialog", { name: "Command palette" });
        await key(document.activeElement ?? document.body, "Escape");
        await waitFor(() => {
          expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
        });
        await waitFor(() => {
          expect(document.activeElement).toBe(title);
        });
        await act(async () => {
          answer.settle(json(SUGGESTION));
          await Promise.resolve();
        });
      });
    });
  });

  describe("when a chip that holds focus is taken", () => {
    it("moves focus to the title it filled", async () => {
      const dialog = await openNew();
      await type("URL", DOCS);
      await type("Title", "Mine");
      await suggest(dialog);
      const chip = await within(await within(dialog).findByRole("group", { name: "Suggested title" })).findByRole("button", { name: "Docs: the manual" });
      chip.focus();

      await press(chip);

      expect(titleField().value).toBe("Docs: the manual");
      expect(document.activeElement).toBe(titleField());
    });

    it("moves focus to the slug it filled", async () => {
      const dialog = await openNew();
      await type("URL", DOCS);
      await type("Slug", "mine");
      await suggest(dialog);
      const chip = await within(await within(dialog).findByRole("group", { name: "Suggested slug" })).findByRole("button", { name: "manual" });
      chip.focus();

      await press(chip);

      expect(slugField().value).toBe("manual");
      expect(document.activeElement).toBe(slugField());
    });

    it("moves focus to the next tag chip, and from the last one to the tags field", async () => {
      use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, tags: ["Reading", "Docs", "Manuals"] }) });
      const dialog = await openNew();
      await type("URL", DOCS);
      await type("Title", "Mine");
      await type("Slug", "mine");
      await createTag(dialog, "Own");
      await suggest(dialog);
      const tags = await within(dialog).findByRole("group", { name: "Suggested tags", hidden: true });
      const chip = (name: string): HTMLElement => within(tags).getByRole("button", { name, hidden: true });
      chip("Reading").focus();

      await press(chip("Reading"));
      expect(document.activeElement).toBe(chip("Docs"));

      await press(chip("Manuals"));
      expect(document.activeElement).toBe(chip("Docs"));

      await press(chip("Docs"));
      expect(document.activeElement).toBe(within(dialog).getByLabelText("Tags"));
      expect(within(dialog).queryByRole("group", { name: "Suggested tags", hidden: true })).toBeNull();
    });
  });

  describe("while it is not yet known whether the action is offered", () => {
    const row = (dialog: HTMLElement): Element | null => dialog.querySelector("[data-slot='suggest-action-pending']");

    it("holds the row the action takes, and puts the action in it when the reads answer", async () => {
      const entitlements = held();
      use({ getEntitlements: () => entitlements.promise });
      const dialog = await openNew();

      await waitFor(() => {
        expect(row(dialog)).not.toBeNull();
      });
      expect(row(dialog)?.getAttribute("aria-hidden")).toBe("true");
      expect(suggestButton(dialog)).toBeNull();
      await act(async () => {
        entitlements.settle(json(entitlementsBody()));
        await Promise.resolve();
      });

      expect(await within(dialog).findByRole("button", { name: "Suggest" })).toBeTruthy();
      expect(row(dialog)).toBeNull();
    });

    it.each([
      ["the account", "getMe", () => json(meOf({ ...ACCOUNT_BODY, aiOptOut: world.optOut }))],
      ["the workspace", "getWorkspace", () => json(workspaceBody(), { headers: { ETag: '"1"' } })],
    ])("holds the row while %s is read again on the next visit, though the last visit read it", async (_name, operation, answer) => {
      const first = await openNew();
      await within(first).findByRole("button", { name: "Suggest" });
      const reading = held();
      use({ [operation]: () => reading.promise });

      const second = await reopen(first);

      await waitFor(() => {
        expect(row(second)).not.toBeNull();
      });
      expect(suggestButton(second)).toBeNull();
      await act(async () => {
        reading.settle(answer());
        await Promise.resolve();
      });
      expect(await within(second).findByRole("button", { name: "Suggest" })).toBeTruthy();
      expect(row(second)).toBeNull();
    });

    it("gives the row up when the reads say the member does not get the action", async () => {
      const entitlements = held();
      world.entitled = false;
      use({ getEntitlements: () => entitlements.promise });
      const dialog = await openNew();
      await waitFor(() => {
        expect(row(dialog)).not.toBeNull();
      });

      await act(async () => {
        entitlements.settle(json(entitlementsBody()));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(row(dialog)).toBeNull();
      });
      expect(suggestButton(dialog)).toBeNull();
    });

    it("holds no row where the instance has no AI adapter", async () => {
      world.ai = false;
      const dialog = await openNew();
      await within(dialog).findByLabelText("URL");
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(row(dialog)).toBeNull();
    });
  });

  it("keeps the focus on Save while the save is under way and after the API refuses the slug", async () => {
    const answer = held();
    use({
      createBookmark: async (request) => {
        created.push(await request.clone().json());
        return answer.promise;
      },
    });
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Mine");
    await type("Slug", "taken-one");
    const saveButton = within(dialog).getByRole("button", { name: "Save", hidden: true });
    saveButton.focus();

    await press(saveButton);

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(saveButton.getAttribute("aria-disabled")).toBe("true");
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(saveButton);
    await press(saveButton);
    expect(created).toHaveLength(1);
    await act(async () => {
      answer.settle(problem(409, "slug_taken", "req-taken"));
      await Promise.resolve();
    });

    expect(await within(dialog).findByText("You already use this slug on another bookmark. Choose a different one.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New bookmark" })).toBeTruthy();
    expect(document.activeElement).toBe(saveButton);
    await key(saveButton, "?");
    expect(shortcutSheet()).toBeNull();
  });

  it("fills an empty title, slug and tags, with a shimmer on them meanwhile, and names the fields in the save", async () => {
    const answer = held();
    use({
      suggestBookmarkDetails: async (request) => {
        requests.push(await request.clone().json());
        return answer.promise;
      },
    });
    const dialog = await openNew();
    await type("URL", DOCS);

    await suggest(dialog);

    await waitFor(() => {
      expect(shimmers(dialog)).toBe(3);
    });
    expect(requests).toEqual([{ url: DOCS, locale: "en" }]);
    await act(async () => {
      answer.settle(json(SUGGESTION));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });
    expect(shimmers(dialog)).toBe(0);
    expect(slugField().value).toBe("manual");
    expect(within(dialog).getByRole("button", { name: "Remove Reading" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Remove Docs" })).toBeTruthy();
    expect(within(dialog).queryByRole("group", { name: "Suggested title" })).toBeNull();

    await save(dialog);
    expect(created).toEqual([
      { url: DOCS, title: "Docs: the manual", slug: "manual", forwarding: true, tagIds: [TAG_ID], tagNames: ["Docs"], aiFields: ["title", "slug", "tags"] },
    ]);
  });

  it("sends the language of the interface and the metadata the page gave, and nothing of the form", async () => {
    use({ fetchBookmarkMetadata: () => json({ title: "Page title", description: "Page words", siteName: null, canonicalUrl: null, language: null, cached: false }) });
    const dialog = await openNew();
    await type("URL", DOCS);
    await act(async () => {
      fireEvent.blur(screen.getByLabelText("URL"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titleField().value).toBe("Page title");
    });
    await type("Title", "My own title");

    await suggest(dialog);

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests).toEqual([{ url: DOCS, locale: "en", metadata: { title: "Page title", description: "Page words" } }]);
  });

  it("offers chips for the fields the member filled, overwrites none of them, and fills only the empty one", async () => {
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Mine");
    await type("Slug", "mine");

    await suggest(dialog);

    const title = await within(dialog).findByRole("group", { name: "Suggested title" });
    const chip = within(title).getByRole("button", { name: "Docs: the manual" });
    expect(chip.getAttribute("data-slot")).toBe("badge");
    expect(chip.tagName).toBe("BUTTON");
    expect(within(dialog).getByRole("group", { name: "Suggested slug" })).toBeTruthy();
    expect(titleField().value).toBe("Mine");
    expect(slugField().value).toBe("mine");
    expect(within(dialog).getByRole("button", { name: "Remove Reading" })).toBeTruthy();
    expect(within(dialog).queryByRole("group", { name: "Suggested tags" })).toBeNull();
  });

  it("takes a chip into the field, counts it in the save and leaves the ignored ones out", async () => {
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, tags: [] }) });
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Mine");
    await type("Slug", "mine");
    await suggest(dialog);
    const title = await within(dialog).findByRole("group", { name: "Suggested title" });

    await press(within(title).getByRole("button", { name: "Docs: the manual" }));

    expect(titleField().value).toBe("Docs: the manual");
    expect(within(dialog).queryByRole("group", { name: "Suggested title" })).toBeNull();
    expect(slugField().value).toBe("mine");
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "Docs: the manual", slug: "mine", forwarding: true, aiFields: ["title"] }]);
  });

  it("offers the suggested tags as chips beside a tag the member chose, and adds the one they take", async () => {
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, tags: ["Reading", "Docs"] }) });
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Mine");
    await type("Slug", "mine");
    await createTag(dialog, "Own");

    await suggest(dialog);

    const tags = await within(dialog).findByRole("group", { name: "Suggested tags", hidden: true });
    expect(within(tags).getAllByRole("button", { hidden: true }).map((chip) => chip.textContent)).toEqual(["Reading", "Docs"]);
    await press(within(tags).getByRole("button", { name: "Docs", hidden: true }));
    expect(within(dialog).getByRole("button", { name: "Remove Docs", hidden: true })).toBeTruthy();
    expect(within(tags).queryByRole("button", { name: "Docs", hidden: true })).toBeNull();
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "Mine", slug: "mine", forwarding: true, tagNames: ["Own", "Docs"], aiFields: ["tags"] }]);
  });

  it("does not name a field the member changed after it was filled, and not a tag they took off", async () => {
    const dialog = await openNew();
    await type("URL", DOCS);
    await suggest(dialog);
    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });

    await type("Title", "Docs: my manual");
    await press(within(dialog).getByRole("button", { name: "Remove Reading" }));
    await press(within(dialog).getByRole("button", { name: "Remove Docs" }));
    await save(dialog);

    expect(created).toEqual([{ url: DOCS, title: "Docs: my manual", slug: "manual", forwarding: true, aiFields: ["slug"] }]);
  });

  it("sends no aiFields for a bookmark whose values the member typed", async () => {
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Typed");

    await save(dialog);

    expect(created).toEqual([{ url: DOCS, title: "Typed" }]);
    expect(requests).toEqual([]);
  });

  it("does not overwrite what the member typed while the request ran, and offers it as a chip", async () => {
    const answer = held();
    use({ suggestBookmarkDetails: () => answer.promise });
    const dialog = await openNew();
    await type("URL", DOCS);
    await suggest(dialog);
    await waitFor(() => {
      expect(shimmers(dialog)).toBe(3);
    });

    await type("Title", "Typed meanwhile");
    await act(async () => {
      answer.settle(json(SUGGESTION));
      await Promise.resolve();
    });

    await within(dialog).findByRole("group", { name: "Suggested title" });
    expect(titleField().value).toBe("Typed meanwhile");
    expect(slugField().value).toBe("manual");
    await save(dialog);
    expect((created[0] as { aiFields: string[] }).aiFields).toEqual(["slug", "tags"]);
  });

  it("drops the answer for an address the field no longer holds, with its chips and its shimmer", async () => {
    const answer = held();
    use({ suggestBookmarkDetails: () => answer.promise });
    const dialog = await openNew();
    await type("URL", DOCS);
    await suggest(dialog);
    await waitFor(() => {
      expect(shimmers(dialog)).toBe(3);
    });

    await type("URL", BLOG);
    expect(shimmers(dialog)).toBe(0);
    await act(async () => {
      answer.settle(json(SUGGESTION));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(titleField().value).toBe("");
    expect(slugField().value).toBe("");
    expect(within(dialog).queryByRole("button", { name: "Remove Reading" })).toBeNull();
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  it("takes back the chips of an address when the address changes", async () => {
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Mine");
    await suggest(dialog);
    await within(dialog).findByRole("group", { name: "Suggested title" });

    await type("URL", BLOG);

    expect(within(dialog).queryByRole("group", { name: "Suggested title" })).toBeNull();
  });

  it("aborts the request when the modal is closed, and applies nothing", async () => {
    const answer = held();
    let signal: AbortSignal | undefined;
    use({
      suggestBookmarkDetails: (request) => {
        signal = request.signal;
        return answer.promise;
      },
    });
    const dialog = await openNew([], `?new=1&url=${encodeURIComponent(DOCS)}`);
    await suggest(dialog);
    await waitFor(() => {
      expect(signal).toBeDefined();
    });

    await press(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New bookmark" })).toBeNull();
    });

    expect(signal?.aborted).toBe(true);
    await act(async () => {
      answer.settle(json(SUGGESTION));
      await Promise.resolve();
    });
  });

  it("asks for an address first when the field holds none", async () => {
    const dialog = await openNew();

    await suggest(dialog);

    expect(await within(dialog).findByText("Enter the address to save.")).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it("does not offer a slug that is taken, or whose check failed", async () => {
    use({ checkSlugAvailability: () => json({ status: "taken_by_me", othersUseCount: 0 }) });
    const dialog = await openNew();
    await type("URL", DOCS);

    await suggest(dialog);

    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });
    expect(slugField().value).toBe("");
    expect(within(dialog).queryByRole("group", { name: "Suggested slug" })).toBeNull();
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "Docs: the manual", tagIds: [TAG_ID], tagNames: ["Docs"], aiFields: ["title", "tags"] }]);
  });

  it("does not fill a slug whose check failed", async () => {
    use({ checkSlugAvailability: () => problem(503, "unavailable", "req-slug") });
    const dialog = await openNew();
    await type("URL", DOCS);

    await suggest(dialog);

    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });
    expect(slugField().value).toBe("");
  });

  it("sends no slug the server found unusable", async () => {
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, slug: null }) });
    const dialog = await openNew();
    await type("URL", DOCS);

    await suggest(dialog);

    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });
    expect(slugField().value).toBe("");
  });

  it.each([
    ["the provider fails", () => problem(502, "upstream_failed", "req-1"), true],
    ["the rate limit is reached", () => problem(429, "rate_limited", "req-2"), true],
    ["the connection fails", () => Response.error(), true],
    ["the answer is not a document", () => new Response("<html>", { status: 500 }), true],
    ["the instance has lost its adapter", () => problem(503, "ai_unavailable", "req-3"), false],
    ["the toggle was turned off meanwhile", () => problem(403, "forbidden", "req-4"), false],
    ["the entitlement was withdrawn meanwhile", () => problem(403, "entitlement_required", "req-5"), false],
  ])("leaves every field as it is, says so in a note and lets the member save when %s", async (_name, answer, keepsAction) => {
    use({ suggestBookmarkDetails: () => answer() });
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Typed");

    await suggest(dialog);

    expect(await within(dialog).findByText("Suggestions unavailable")).toBeTruthy();
    expect(titleField().value).toBe("Typed");
    expect(slugField().value).toBe("");
    expect(shimmers(dialog)).toBe(0);
    expect(within(dialog).queryByRole("group", { name: "Suggested title" })).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(suggestButton(dialog) !== null).toBe(keepsAction);
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "Typed" }]);
  });

  it("ends the run when the slug check does not answer: the slug is left out and the rest is applied", async () => {
    use({ checkSlugAvailability: () => new Promise<Response>(() => undefined) });
    const dialog = await openNew();
    await type("URL", DOCS);
    const button = await within(dialog).findByRole("button", { name: "Suggest" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

    await press(button);
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS + 100);
    });

    await waitFor(() => {
      expect(titleField().value).toBe("Docs: the manual");
    });
    expect(slugField().value).toBe("");
    expect(shimmers(dialog)).toBe(0);
    expect(button.hasAttribute("data-loading")).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Remove Docs" })).toBeTruthy();
    expect(within(dialog).queryByRole("group", { name: "Suggested slug" })).toBeNull();
  });

  it("gives up on a request that does not answer, and leaves the fields as they are", async () => {
    use({ suggestBookmarkDetails: () => new Promise<Response>(() => undefined) });
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Typed");
    const button = await within(dialog).findByRole("button", { name: "Suggest" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

    await press(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS + 100);
    });

    expect(await within(dialog).findByText("Suggestions unavailable")).toBeTruthy();
    expect(titleField().value).toBe("Typed");
    expect(shimmers(dialog)).toBe(0);
  });

  it("shows the text of a suggestion as text", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, title: markup, tags: ["<script>alert(1)</script>", "Docs"] }) });
    const dialog = await openNew();
    await type("URL", DOCS);

    await suggest(dialog);

    await waitFor(() => {
      expect(titleField().value).toBe(markup);
    });
    expect(within(dialog).getByRole("button", { name: "Remove <script>alert(1)</script>" })).toBeTruthy();
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("script")).toBeNull();
  });

  it("shows a hostile suggestion for a field the member filled as the text of a chip", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, title: markup }) });
    const dialog = await openNew();
    await type("URL", DOCS);
    await type("Title", "Mine");

    await suggest(dialog);

    const chip = await within(dialog).findByRole("button", { name: markup });
    expect(chip.textContent).toBe(markup);
    expect(dialog.querySelector("img")).toBeNull();
  });
});

describe("the Suggest action on a bookmark that is changed", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers chips for the values the bookmark has, and names in the patch the fields it takes", async () => {
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, tags: [] }) });
    const dialog = await openEdit();
    await suggest(dialog);
    const title = await within(dialog).findByRole("group", { name: "Suggested title" });
    const slug = within(dialog).getByRole("group", { name: "Suggested slug" });

    await press(within(title).getByRole("button", { name: "Docs: the manual" }));
    await press(within(slug).getByRole("button", { name: "manual" }));
    await save(dialog, updated);

    expect(updated).toEqual([{ title: "Docs: the manual", slug: "manual", aiFields: ["title", "slug"] }]);
  });

  it("names nothing for a chip the member did not take", async () => {
    use({ suggestBookmarkDetails: () => json({ ...SUGGESTION, tags: [] }) });
    const dialog = await openEdit();
    await type("Title", "My edit");
    await suggest(dialog);
    await within(dialog).findByRole("group", { name: "Suggested title" });

    await save(dialog, updated);

    expect(updated).toEqual([{ title: "My edit" }]);
  });

  it("names the tags a suggestion filled in a patch that sends them, and the title and slug of a suggestion that matches the bookmark not at all", async () => {
    use({ suggestBookmarkDetails: () => json({ title: "Example docs", slug: "docs", tags: ["Docs"], confidence: 0.5 }) });
    const dialog = await openEdit();
    await suggest(dialog);
    await within(dialog).findByRole("button", { name: "Remove Docs" });

    await save(dialog, updated);

    expect(updated).toEqual([{ tagIds: [], tagNames: ["Docs"], aiFields: ["tags"] }]);
    expect(within(dialog).queryByRole("group", { name: "Suggested title" })).toBeNull();
  });
});

describe("the Suggest action reads what it depends on again", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("withdraws the action when the entitlements cannot be read again on the next visit, though an earlier visit read them as granted", async () => {
    const first = await openNew();
    await within(first).findByRole("button", { name: "Suggest" });
    world.entitled = "unreadable";

    const second = await reopen(first);
    await within(second).findByLabelText("URL");
    await untilFailed("entitlements");

    expect(suggestButton(second)).toBeNull();
  });

  it("withdraws the upgrade hint when the entitlements cannot be read again, though an earlier visit read them as not granted", async () => {
    const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <p>Upgrade for suggestions</p> } };
    world.entitled = false;
    const first = await openNew([upgrade]);
    await within(first).findByText("Upgrade for suggestions");
    world.entitled = "unreadable";

    const second = await reopen(first);
    await within(second).findByLabelText("URL");
    await untilFailed("entitlements");

    expect(within(second).queryByText("Upgrade for suggestions")).toBeNull();
    expect(suggestButton(second)).toBeNull();
  });

  it("withdraws the action when the account cannot be read again on the next visit", async () => {
    const first = await openNew();
    await within(first).findByRole("button", { name: "Suggest" });
    world.me = "unreadable";

    const second = await reopen(first);
    await within(second).findByLabelText("URL");
    await untilFailed("me");

    expect(suggestButton(second)).toBeNull();
  });

  it("withdraws the upgrade hint when the account cannot be read again on the next visit, though an earlier visit read the plan as not granting it", async () => {
    const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <p>Upgrade for suggestions</p> } };
    world.entitled = false;
    const first = await openNew([upgrade]);
    await within(first).findByText("Upgrade for suggestions");
    world.me = "unreadable";

    const second = await reopen(first);
    await within(second).findByLabelText("URL");
    await untilFailed("me");

    expect(within(second).queryByText("Upgrade for suggestions")).toBeNull();
    expect(suggestButton(second)).toBeNull();
  });

  it("withdraws the action on the next visit when the member opted out elsewhere meanwhile", async () => {
    const first = await openNew();
    await within(first).findByRole("button", { name: "Suggest" });
    world.optOut = true;

    const second = await reopen(first);
    await within(second).findByLabelText("URL");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(suggestButton(second)).toBeNull();
  });

  it("offers the action on the next visit when the member opted back in elsewhere meanwhile", async () => {
    world.optOut = true;
    const first = await openNew();
    await within(first).findByLabelText("URL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(suggestButton(first)).toBeNull();
    world.optOut = false;

    const second = await reopen(first);

    expect(await within(second).findByRole("button", { name: "Suggest" })).toBeTruthy();
  });

  it("follows an opt-out made elsewhere when the window regains focus with the modal open", async () => {
    const dialog = await openNew();
    await within(dialog).findByRole("button", { name: "Suggest" });
    world.optOut = true;

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(suggestButton(dialog)).toBeNull();
    });
  });

  it("withdraws the action when the workspace cannot be read again on the next visit", async () => {
    const first = await openNew();
    await within(first).findByRole("button", { name: "Suggest" });
    world.workspace = "unreadable";

    const second = await reopen(first);
    await within(second).findByLabelText("URL");
    await untilFailed("workspace");

    expect(suggestButton(second)).toBeNull();
  });
});

