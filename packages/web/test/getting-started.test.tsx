import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { ACCOUNT_BODY, allowSlowRender, json, meOf, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Getting started checklist (doc 03 sections 2, 8 and 11.4, doc 02 section 9.3) against the handlers generated from openapi.json,
// with the account and the dashboard kept the way the API keeps them: the stored keys change only when PATCH /me says so. The failure
// scenarios are a step ticked from anything but the answer (a failed save shown as done, a mark that never reaches the account),
// a Dismiss that hides the card before the server has it or that leaves it out of date after, a restore switch that does not bring
// the card back, a complete checklist that stays a five-item card, an Import action that leads nowhere, and a mark, dismissal or
// restore sent with the wrong keys.

type Dashboard = ComponentTypes["schemas"]["Dashboard"];
type Onboarding = ComponentTypes["schemas"]["Onboarding"];
type Real = Pick<Dashboard["onboarding"], "bookmarkAdded" | "slugGiven" | "folderCreated">;

const server = createMockServer();
const document_ = readOpenApiDocument();

const REAL: Real = { bookmarkAdded: true, slugGiven: false, folderCreated: false };

interface World {
  real: Real;
  stored: Onboarding;
  /** The status PATCH /me is refused with, or none. */
  refuse: number | undefined;
  patches: unknown[];
  dashboardReads: number;
}

let world: World;

function newWorld(overrides: Partial<World> = {}): World {
  return { real: REAL, stored: { browserSetupDone: false, importDone: false, checklistDismissed: false }, refuse: undefined, patches: [], dashboardReads: 0, ...overrides };
}

function account(): Omit<typeof ACCOUNT_BODY, "onboarding"> & { onboarding: Onboarding } {
  return { ...ACCOUNT_BODY, onboarding: world.stored };
}

function dashboardOf(): Dashboard {
  return {
    counts: { bookmarks: 3, folders: 0, tags: 0, sharedWithYou: null },
    quickAccess: [],
    pinned: [],
    topTags: [],
    sharing: null,
    onboarding: { ...world.real, browserSetupDone: world.stored.browserSetupDone, importDone: world.stored.importDone, dismissed: world.stored.checklistDismissed },
  };
}

function serve(): void {
  server.use(...createHandlers(document_, { scenario: { name: "checklist" } }));
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json(meOf(account())),
      getDashboard: () => {
        world.dashboardReads += 1;
        return json(dashboardOf());
      },
      updateMe: async (request) => {
        const body = (await request.json()) as { onboarding?: Partial<Onboarding> };
        world.patches.push(body);
        if (world.refuse !== undefined) {
          return problem(world.refuse, world.refuse === 503 ? "unavailable" : "internal_error", "req-refused");
        }
        world.stored = { ...world.stored, ...body.onboarding };
        return json(account());
      },
    }),
  );
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

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  world = newWorld();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApp(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function card(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { level: 2, name: "Getting started" });
  const region = heading.closest("[data-slot='card']");
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

function ticked(region: HTMLElement): Record<string, boolean> {
  return Object.fromEntries(within(region).getAllByRole("checkbox").map((box) => [box.getAttribute("aria-labelledby") === null ? "?" : (document.getElementById(box.getAttribute("aria-labelledby") ?? "")?.textContent ?? "?"), box.getAttribute("aria-checked") === "true"]));
}

describe("the checklist card", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists the five steps with read-only boxes ticked from the answer, and a progress bar that counts them", async () => {
    world = newWorld({ real: { bookmarkAdded: true, slugGiven: true, folderCreated: false }, stored: { browserSetupDone: true, importDone: false, checklistDismissed: false } });
    serve();
    await openApp("/");

    const region = await card();
    expect(ticked(region)).toEqual({
      "Add a bookmark": true,
      "Give a bookmark a slug": true,
      "Set up the browser search engine": true,
      "Create a folder": false,
      "Import from your browser": false,
    });
    for (const box of within(region).getAllByRole("checkbox")) {
      expect(box.getAttribute("aria-readonly")).toBe("true");
    }
    const bar = within(region).getByRole("progressbar", { name: "Getting started progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(within(region).getByText("3 of 5 done")).toBeTruthy();
  });

  it("does not tick a step by clicking its box", async () => {
    serve();
    await openApp("/");

    const region = await card();
    await press(within(region).getByRole("checkbox", { name: "Create a folder" }));

    expect(within(region).getByRole("checkbox", { name: "Create a folder" }).getAttribute("aria-checked")).toBe("false");
    expect(world.patches).toEqual([]);
  });

  it("gives each step its action, and no Import action while the app has no page for it", async () => {
    serve();
    await openApp("/");

    const region = await card();
    expect(within(region).getByRole("button", { name: "New bookmark" })).toBeTruthy();
    expect(within(region).getByRole("link", { name: "Forwarding" }).getAttribute("href")).toBe("/forwarding");
    expect(within(region).getByRole("link", { name: "Forwarding setup" }).getAttribute("href")).toBe("/forwarding");
    expect(within(region).getByRole("link", { name: "New folder" }).getAttribute("href")).toBe("/folders?create=1");
    expect(within(region).queryByRole("link", { name: "Import" })).toBeNull();
    expect(within(region).getByText("Import from your browser")).toBeTruthy();
  });

  it("opens the bookmark modal from the New bookmark action", async () => {
    serve();
    await openApp("/");

    await press(within(await card()).getByRole("button", { name: "New bookmark" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?new=1");
    });
  });

  it("links the Import action to the Import and export page once the app has that page", async () => {
    serve();
    await openApp("/", [{ id: "data", routes: [{ path: "/settings/account/data", component: () => <h1>Import and export</h1> }] }]);

    const link = within(await card()).getByRole("link", { name: "Import" });
    expect(link.getAttribute("href")).toBe("/settings/account/data");

    await press(link);

    expect(await screen.findByRole("heading", { name: "Import and export" })).toBeTruthy();
  });

  it("takes the place of nothing else: it is below the rows and follows the loading state of the screen", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve();
    server.use(
      ...createResolverHandlers(document_, {
        getDashboard: async () => {
          await held;
          return json(dashboardOf());
        },
      }),
    );
    await openApp("/");

    await screen.findByRole("status", { name: "Loading your home screen" });
    expect(screen.queryByRole("heading", { level: 2, name: "Getting started" })).toBeNull();
    release();

    expect(await card()).toBeTruthy();
  });

  it("is not shown when the dashboard cannot be read, only the error banner is", async () => {
    serve();
    server.use(...createResolverHandlers(document_, { getDashboard: () => problem(503, "unavailable", "req-503") }));
    await openApp("/");

    expect(await screen.findByText("The home screen could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Getting started" })).toBeNull();
  });
});

describe("dismissing the checklist", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("stores the dismissal through PATCH /me, then hides the card and reads the dashboard again", async () => {
    serve();
    await openApp("/");
    const region = await card();
    const reads = world.dashboardReads;

    await press(within(region).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { level: 2, name: "Getting started" })).toBeNull();
    });
    expect(world.patches).toEqual([{ onboarding: { checklistDismissed: true } }]);
    await waitFor(() => {
      expect(world.dashboardReads).toBeGreaterThan(reads);
    });
    expect(world.stored.checklistDismissed).toBe(true);
  });

  it("keeps the card and says so when the dismissal could not be stored", async () => {
    world = newWorld({ refuse: 503 });
    serve();
    await openApp("/");
    const region = await card();

    await press(within(region).getByRole("button", { name: "Dismiss" }));

    expect(await within(region).findByText("The checklist could not be dismissed. Try again in a moment.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Getting started" })).toBeTruthy();
    expect(world.stored.checklistDismissed).toBe(false);
  });

  it("is not shown at all when the account dismissed it", async () => {
    world = newWorld({ stored: { browserSetupDone: false, importDone: false, checklistDismissed: true } });
    serve();
    await openApp("/");

    await screen.findByRole("group", { name: "Totals" });
    expect(screen.queryByRole("heading", { level: 2, name: "Getting started" })).toBeNull();
  });
});

describe("a complete checklist", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("collapses to one line, All set, with Dismiss", async () => {
    world = newWorld({ real: { bookmarkAdded: true, slugGiven: true, folderCreated: true }, stored: { browserSetupDone: true, importDone: true, checklistDismissed: false } });
    serve();
    await openApp("/");

    const line = await screen.findByText("All set");
    expect(screen.queryByRole("heading", { level: 2, name: "Getting started" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    await press(within(line.closest("[role='status']") as HTMLElement).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByText("All set")).toBeNull();
    });
    expect(world.patches).toEqual([{ onboarding: { checklistDismissed: true } }]);
  });
});

describe("Mark as done on the Forwarding page", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("stores the browser setup through PATCH /me and shows it done, and the checklist ticks it", async () => {
    serve();
    await openApp("/forwarding");

    await press(await screen.findByRole("button", { name: "Mark as done" }));

    expect(await screen.findByText("Marked as done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as done" })).toBeNull();
    expect(world.patches).toEqual([{ onboarding: { browserSetupDone: true } }]);

    await press(screen.getByRole("link", { name: "Home" }));
    const region = await card();
    expect(ticked(region)["Set up the browser search engine"]).toBe(true);
  });

  it("does not show the step as done when the save fails, and says so beside the button", async () => {
    world = newWorld({ refuse: 503 });
    serve();
    await openApp("/forwarding");

    await press(await screen.findByRole("button", { name: "Mark as done" }));

    expect(await screen.findByText("The setup could not be marked as done. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("Marked as done")).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as done" })).toBeTruthy();
    expect(world.stored.browserSetupDone).toBe(false);

    await press(screen.getByRole("link", { name: "Home" }));
    expect(ticked(await card())["Set up the browser search engine"]).toBe(false);
  });

  it("shows the mark as done when the account already has it", async () => {
    world = newWorld({ stored: { browserSetupDone: true, importDone: false, checklistDismissed: false } });
    serve();
    await openApp("/forwarding");

    expect(await screen.findByText("Marked as done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as done" })).toBeNull();
  });
});

describe("restoring the checklist from Preferences", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("has a switch that is off while the checklist is dismissed, and turning it on brings the card back on Home", async () => {
    world = newWorld({ stored: { browserSetupDone: false, importDone: false, checklistDismissed: true } });
    serve();
    await openApp("/settings/account/preferences");

    const toggle = await screen.findByRole("switch", { name: "Show the Getting started checklist" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await press(toggle);

    await waitFor(() => {
      expect(world.patches).toEqual([{ onboarding: { checklistDismissed: false } }]);
    });
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Show the Getting started checklist" }).getAttribute("aria-checked")).toBe("true");
    });

    await press(screen.getByRole("link", { name: "Home" }));
    expect(await card()).toBeTruthy();
  });

  it("turning the switch off dismisses the checklist", async () => {
    serve();
    await openApp("/settings/account/preferences");

    const toggle = await screen.findByRole("switch", { name: "Show the Getting started checklist" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await press(toggle);

    await waitFor(() => {
      expect(world.patches).toEqual([{ onboarding: { checklistDismissed: true } }]);
    });
  });

  it("goes back to off and shows the error when the restore could not be stored", async () => {
    world = newWorld({ stored: { browserSetupDone: false, importDone: false, checklistDismissed: true }, refuse: 503 });
    serve();
    await openApp("/settings/account/preferences");

    await press(await screen.findByRole("switch", { name: "Show the Getting started checklist" }));

    expect(await screen.findByText("This change was not saved.")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show the Getting started checklist" }).getAttribute("aria-checked")).toBe("false");
  });
});
