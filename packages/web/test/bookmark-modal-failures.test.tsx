import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { CONFIG_BODY, ME_PATH, SESSION_BODY, SESSION_PATH, json, meBody, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The bookmark modal's refusals and the page's own handling of a paste, against a stubbed transport. The failure scenarios
// are a limit shown as a generic failure or without the upgrade slot, a refused address that is not put on the address
// field, a save that is sent despite the shortcut being pressed inside the wrong place, and a paste into a field, or on
// another page, that opens the modal.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Transport = (request: Request) => Promise<Response>;

const BOOKMARKS_PATH = "/api/v1/bookmarks";
const ID = "0192f3a0-aaaa-7000-8000-000000000001";

const BOOKMARK: Bookmark = {
  id: ID,
  ownerId: "0192f3a0-bbbb-7000-8000-000000000001",
  url: "https://example.com/docs",
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

const UPGRADE: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };

function withErrors(status: number, code: string, errors: readonly { path: string; code: string }[]): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "x", requestId: "req-422", errors },
    { status, contentType: "application/problem+json" },
  );
}

interface Server {
  readonly posts: unknown[];
  readonly patches: unknown[];
}

/** A signed-in server whose bookmark operations answer as `create` and `read` say (a created bookmark by default). */
function stubServer(answers: { create?: () => Response; read?: () => Response } = {}): Server {
  const posts: unknown[] = [];
  const patches: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>(async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/config") {
        return json(CONFIG_BODY);
      }
      if (pathname === ME_PATH) {
        return json(meBody());
      }
      if (pathname === SESSION_PATH) {
        return json(SESSION_BODY);
      }
      if (pathname === BOOKMARKS_PATH && request.method === "POST") {
        posts.push(JSON.parse(await request.clone().text()) as unknown);
        return answers.create?.() ?? json(BOOKMARK, { status: 201 });
      }
      if (pathname === BOOKMARKS_PATH && request.method === "GET") {
        return json({ items: [], nextCursor: null, total: 0 });
      }
      if (pathname === `${BOOKMARKS_PATH}/${ID}` && request.method === "GET") {
        return answers.read?.() ?? json(BOOKMARK);
      }
      if (pathname === `${BOOKMARKS_PATH}/${ID}` && request.method === "PATCH") {
        patches.push(JSON.parse(await request.clone().text()) as unknown);
        return json({ ...BOOKMARK, version: 2 });
      }
      if (pathname === "/api/v1/workspaces" || pathname === "/api/v1/entitlements") {
        return problem(503, "unavailable", "req-503");
      }
      return problem(404, "not_found", "req-404");
    }),
  );
  return { posts, patches };
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

async function openApp(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function act_(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function type(label: string, value: string): Promise<void> {
  await act_(() => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}

function modal(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: /^(New|Edit) bookmark$/ });
}

async function fillAndSave(): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
  await type("URL", "https://example.com/docs");
  await type("Title", "Example docs");
  await act_(() => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  });
  return dialog;
}

const SETTLE_MS = 300;

/** Fires a paste carrying `text` and waits for whatever navigation it starts to settle; true when no listener prevented it. */
async function pasteOnto(target: Element | Document, text: string): Promise<boolean> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  let notPrevented = true;
  await act(async () => {
    notPrevented = target.dispatchEvent(event);
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
  });
  return notPrevented;
}

describe("a refused save", () => {
  it("renders the bookmark limit through the entitlement.upgradeAction slot, and keeps the form", async () => {
    stubServer({ create: () => problem(422, "bookmark_limit_reached", "req-limit") });
    await openApp("/?new=1", [UPGRADE]);

    const dialog = await fillAndSave();

    expect(await within(dialog).findByText("Bookmark limit reached")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Upgrade plan" })).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Example docs");
  });

  it("says only the limit in a deployment that fills no slot", async () => {
    stubServer({ create: () => problem(422, "bookmark_limit_reached", "req-limit") });
    await openApp("/?new=1");

    const dialog = await fillAndSave();

    expect(await within(dialog).findByText("Bookmark limit reached")).toBeTruthy();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("puts url_not_allowed on the address field", async () => {
    stubServer({ create: () => problem(422, "url_not_allowed", "req-url") });
    await openApp("/?new=1");

    const dialog = await fillAndSave();

    const field = within(dialog).getByLabelText("URL");
    expect(await within(dialog).findByText("Enter an address that starts with http:// or https://.")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("puts the fields a validation_failed names on those fields", async () => {
    stubServer({
      create: () =>
        withErrors(422, "validation_failed", [
          { path: "title", code: "too_big" },
          { path: "url", code: "invalid_url" },
        ]),
    });
    await openApp("/?new=1");

    const dialog = await fillAndSave();

    expect(await within(dialog).findByText("Use at most 300 characters.")).toBeTruthy();
    expect(within(dialog).getByText("This is not a valid address.")).toBeTruthy();
    expect(within(dialog).getByLabelText("Title").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the form open with an error when the save fails", async () => {
    stubServer({ create: () => problem(503, "unavailable", "req-503") });
    await openApp("/?new=1");

    const dialog = await fillAndSave();

    expect(await within(dialog).findByText("The bookmark could not be saved right now. Try again in a moment.")).toBeTruthy();
    expect(modal()).toBeTruthy();
    expect(window.location.search).toBe("?new=1");
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false);
  });
});

describe("the keyboard", () => {
  it("saves with Ctrl+Enter and with Cmd+Enter, and not with a plain Enter in the description", async () => {
    const server = stubServer();
    await openApp("/?new=1");
    await screen.findByRole("dialog", { name: "New bookmark" });
    await type("URL", "https://example.com/docs");
    await type("Title", "Example docs");

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
    });
    await act_(() => {
      fireEvent.keyDown(screen.getByLabelText("Description"), { key: "Enter" });
    });
    expect(server.posts).toHaveLength(0);

    await act_(() => {
      fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter", ctrlKey: true });
    });

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.posts).toEqual([{ url: "https://example.com/docs", title: "Example docs" }]);
  });

  it("saves with Cmd+Enter", async () => {
    const server = stubServer();
    await openApp("/?new=1");
    await screen.findByRole("dialog", { name: "New bookmark" });
    await type("URL", "https://example.com/docs");
    await type("Title", "Example docs");

    await act_(() => {
      fireEvent.keyDown(screen.getByLabelText("URL"), { key: "Enter", metaKey: true });
    });

    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
  });
});

describe("the description", () => {
  it("is collapsed under More, counts up to 1,000, and is sent trimmed", async () => {
    const server = stubServer();
    await openApp("/?new=1");
    await screen.findByRole("dialog", { name: "New bookmark" });
    expect(screen.queryByLabelText("Description")).toBeNull();

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
    });
    expect(screen.getByText("0 / 1,000")).toBeTruthy();
    expect(screen.getByLabelText("Description").getAttribute("maxlength")).toBe("1000");
    await type("Description", "  A note  ");
    expect(screen.getByText("10 / 1,000")).toBeTruthy();

    await type("URL", "https://example.com/docs");
    await type("Title", "Example docs");
    await act_(() => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "New bookmark" })).getByRole("button", { name: "Save" }));
    });

    await waitFor(() => {
      expect(server.posts).toEqual([{ url: "https://example.com/docs", title: "Example docs", description: "A note" }]);
    });
  });

  it("clears a description that is emptied when the bookmark is changed", async () => {
    const server = stubServer({ read: () => json({ ...BOOKMARK, description: "Old note" }) });
    await openApp(`/bookmarks?bookmark=${ID}`);
    expect((await screen.findByLabelText<HTMLTextAreaElement>("Description")).value).toBe("Old note");

    await type("Description", "");
    await act_(() => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Edit bookmark" })).getByRole("button", { name: "Save" }));
    });

    await waitFor(() => {
      expect(server.patches).toEqual([{ description: null }]);
    });
  });
});

describe("pasting an address on /bookmarks", () => {
  it("opens the modal prefilled with an address pasted outside a field", async () => {
    stubServer();
    await openApp("/bookmarks");
    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });

    const notPrevented = await pasteOnto(document.body, " https://example.com/pasted ");

    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe("https://example.com/pasted");
    expect(notPrevented).toBe(false);
    expect(window.location.search).toBe("?new=1&url=https%3A%2F%2Fexample.com%2Fpasted");
  });

  it("leaves a paste into a field and text that is no web address alone", async () => {
    stubServer();
    await openApp("/bookmarks");
    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });

    const field = document.createElement("input");
    document.body.append(field);
    await pasteOnto(field, "https://example.com/pasted");
    await pasteOnto(document.body, "javascript:alert(1)");
    await pasteOnto(document.body, "just some words");
    expect(modal()).toBeNull();
    expect(window.location.search).toBe("");
    field.remove();
  });

  it("does not listen on a page other than /bookmarks", async () => {
    stubServer();
    await openApp("/");
    await screen.findByRole("heading", { level: 1 });

    await pasteOnto(document.body, "https://example.com/pasted");

    expect(modal()).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("opens the modal for a second address while the first save's toast is still showing", async () => {
    stubServer();
    await openApp("/bookmarks");
    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    await pasteOnto(document.body, "https://example.com/first");
    const first = await screen.findByRole("dialog", { name: "New bookmark" });
    await act_(() => {
      fireEvent.change(within(first).getByLabelText("Title"), { target: { value: "First" } });
    });
    await act_(() => {
      fireEvent.click(within(first).getByRole("button", { name: "Save" }));
    });
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(await screen.findByText("Bookmark saved.")).toBeTruthy();

    await pasteOnto(document.body, "https://example.com/second");

    const second = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(second).getByLabelText<HTMLInputElement>("URL").value).toBe("https://example.com/second");
  });
});
