import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// A route change behind an edited form overlay (doc 03 `form-overlay`, `unsaved-guard`): back, forward and a palette command ask the
// discard question first, whichever form is open. Keeping the form leaves the address and the edit as they were; discarding
// completes the navigation that was asked for. An unedited form, a saved one and the sign-in flow's own redirects ask nothing.
// Failure scenarios: a navigation that is let through with the edit still in the form, a question that is asked for a form that
// was saved or never edited, a navigation that stays held after the member discarded, a kept form whose address moved on, and a
// session that ended behind an edited form that cannot reach the sign-in page.

const FOLDERS = "/api/v1/folders";
const QUESTION = "Discard your changes?";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Server {
  readonly calls: Call[];
  /** Makes every later API read answer as a session that has ended. */
  readonly endSession: () => void;
}

function serve(): Server {
  const calls: Call[] = [];
  let ended = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((request: Request) =>
      signedIn(request, async (other) => {
        const url = new URL(other.url);
        if (ended && url.pathname !== "/api/config") {
          return problem(401, "unauthenticated", "req-401");
        }
        const text = other.method === "GET" || other.method === "DELETE" ? "" : await other.clone().text();
        calls.push({ method: other.method, path: url.pathname, body: text === "" ? undefined : JSON.parse(text) });
        if (url.pathname === FOLDERS && other.method === "POST") {
          const created = { id: "0192f3a0-dddd-7000-8000-000000000101", ownerId: "0192f3a0-bbbb-7000-8000-000000000001", name: "Recipes", icon: "folder", color: 1, bookmarkCount: 0, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" };
          return json(created, { status: 201 });
        }
        if (url.pathname === "/api/v1/entitlements") {
          return json({
            entitlements: { "bookmarks.max": "unlimited", "seats.max": "unlimited", "workspaces.ownMax": "unlimited", "ai.suggestions": true, "sharing.members": false, "sharing.teams": false, "members.invite": true, "teams.manage": true, "audit.log": true },
            usage: { "bookmarks.used": 0, "seats.used": 1, "workspaces.owned": 1 },
            upgradeAvailable: false,
          });
        }
        if (url.pathname === "/api/v1/search") {
          return json({ bookmarks: [], folders: [], tags: [] });
        }
        return json({ items: [], nextCursor: null, total: 0 });
      }),
    ),
  );
  return {
    calls,
    endSession: () => {
      ended = true;
    },
  };
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
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

async function type(dialog: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
    await Promise.resolve();
  });
}

/** The browser's back or forward button: the traversal reaches the page as a popstate event a moment later. */
async function traverse(direction: "back" | "forward"): Promise<void> {
  await act(async () => {
    if (direction === "back") {
      window.history.back();
    } else {
      window.history.forward();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function openPalette(): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await Promise.resolve();
  });
  return screen.findByRole("dialog", { name: "Command palette" });
}

async function paletteGoTo(name: RegExp): Promise<void> {
  const palette = await openPalette();
  await press(await within(palette).findByRole("option", { name }));
}

/** The create-folder form of /folders, open from its button with `name` typed into it. */
async function openEditedForm(name = "Recipes"): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 2, name: "No folders yet" });
  await press(screen.getAllByRole("button", { name: "New folder" })[0] as HTMLElement);
  const dialog = await screen.findByRole("dialog", { name: "New folder" });
  await type(dialog, name);
  return dialog;
}

function nameOf(dialog: HTMLElement): string {
  return within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value;
}

async function question(): Promise<HTMLElement> {
  return screen.findByRole("alertdialog", { name: QUESTION });
}

describe("leaving an edited form by the browser's buttons", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks on Back, keeps the form and the address on Keep editing, and closes the form on Discard", async () => {
    serve();
    await openApp("/folders");
    const dialog = await openEditedForm();
    expect(window.location.search).toBe("?create=1");

    await traverse("back");

    const asked = await question();
    await press(within(asked).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "New folder" })).toBe(dialog);
    expect(nameOf(dialog)).toBe("Recipes");
    await waitFor(() => {
      expect(window.location.search).toBe("?create=1");
    });

    await traverse("back");
    await press(within(await question()).getByRole("button", { name: "Discard changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    expect(window.location.pathname).toBe("/folders");
    expect(window.location.search).toBe("");
  });

  it("asks on Forward, and on Discard goes to the page the Forward button led to", async () => {
    serve();
    await openApp("/folders");
    await screen.findByRole("heading", { level: 2, name: "No folders yet" });
    await press(screen.getAllByRole("button", { name: "New folder" })[0] as HTMLElement);
    await screen.findByRole("dialog", { name: "New folder" });
    await paletteGoTo(/^Bookmarks/);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    await traverse("back");
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    await type(dialog, "Recipes");

    await traverse("forward");

    const asked = await question();
    await press(within(asked).getByRole("button", { name: "Keep editing" }));
    expect(nameOf(screen.getByRole("dialog", { name: "New folder" }))).toBe("Recipes");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/folders");
    });

    await traverse("forward");
    await press(within(await question()).getByRole("button", { name: "Discard changes" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
  });

  it("asks nothing for a form with no edit", async () => {
    serve();
    await openApp("/folders");
    await screen.findByRole("heading", { level: 2, name: "No folders yet" });
    await press(screen.getAllByRole("button", { name: "New folder" })[0] as HTMLElement);
    await screen.findByRole("dialog", { name: "New folder" });

    await traverse("back");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
  });
});

describe("leaving an edited form by a palette command", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks, and a Keep editing leaves the page, the address and the edit alone", async () => {
    serve();
    await openApp("/folders");
    const dialog = await openEditedForm();

    await paletteGoTo(/^Bookmarks/);

    const asked = await question();
    expect(window.location.pathname).toBe("/folders");
    await press(within(asked).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
    });
    expect(window.location.pathname).toBe("/folders");
    expect(window.location.search).toBe("?create=1");
    expect(screen.getByRole("dialog", { name: "New folder" })).toBe(dialog);
    expect(nameOf(dialog)).toBe("Recipes");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it("completes the command on Discard, and asks nothing again on the way", async () => {
    serve();
    await openApp("/folders");
    await openEditedForm();

    await paletteGoTo(/^Bookmarks/);
    await press(within(await question()).getByRole("button", { name: "Discard changes" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
  });

  it("asks nothing for a form with no edit", async () => {
    serve();
    await openApp("/folders");
    await screen.findByRole("heading", { level: 2, name: "No folders yet" });
    await press(screen.getAllByRole("button", { name: "New folder" })[0] as HTMLElement);
    await screen.findByRole("dialog", { name: "New folder" });

    await paletteGoTo(/^Bookmarks/);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
  });
});

describe("a form that leaves by itself", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks nothing when a save closes it, and nothing afterwards", async () => {
    const server = serve();
    await openApp("/folders");
    const dialog = await openEditedForm();

    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
    expect(window.location.search).toBe("");
    await paletteGoTo(/^Bookmarks/);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
  });

  it("asks when its own Cancel would lose an edit, and Discard then closes it", async () => {
    serve();
    await openApp("/folders");
    const dialog = await openEditedForm();

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await press(within(await question()).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    expect(window.location.pathname).toBe("/folders");
    expect(window.location.search).toBe("");
  });

  it("does not hold the sign-in redirect of a session that ended behind an edited form", async () => {
    const server = serve();
    await openApp("/folders");
    const dialog = await openEditedForm();
    server.endSession();

    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(screen.queryByRole("alertdialog", { name: QUESTION })).toBeNull();
  });
});
