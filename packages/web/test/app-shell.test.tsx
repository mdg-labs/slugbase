import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { docsUrl } from "../src/shell/docs-url.ts";
import { CONFIG_BODY, PRODUCT_NAME, json, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

function stubTransport(handler: Transport) {
  const fetch = vi.fn<Transport>(handler);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function stubConfig(overrides: Record<string, unknown> = {}): void {
  stubTransport((request) =>
    new URL(request.url).pathname === "/api/config" ? Promise.resolve(json({ ...CONFIG_BODY, ...overrides })) : signedIn(request),
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the app shell around the Home route", () => {
  it("renders the header, navigation and main landmarks with the Home empty state in main", async () => {
    stubConfig();
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    const main = await screen.findByRole("main");
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(within(main).getByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(within(main).getByText("Bookmarks with short, private slugs.")).toBeTruthy();
  });

  it("lists Home and Bookmarks, marks Home as the current page and shows the product name beside the mark", async () => {
    stubConfig();
    const App = createWebApp({ extensions: [] });

    const { container } = await renderApp(<App />);

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Home", "Bookmarks"]);
    expect(links[0]?.getAttribute("href")).toBe("/");
    expect(links[1]?.getAttribute("href")).toBe("/bookmarks");
    expect(links[1]?.getAttribute("aria-current")).toBeNull();
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    const header = container.querySelector<HTMLElement>("[data-slot='sidebar-header']");
    expect(within(header ?? document.body).getByText(PRODUCT_NAME)).toBeTruthy();
    expect(header?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("puts the breadcrumb and the theme toggle in the top bar", async () => {
    stubConfig();
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    const header = await screen.findByRole("banner");
    const breadcrumb = within(header).getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByText("Home").getAttribute("aria-current")).toBe("page");
    const before = document.documentElement.classList.contains("dark");

    fireEvent.click(within(header).getByRole("button", { name: before ? "Switch to light theme" : "Switch to dark theme" }));

    expect(document.documentElement.classList.contains("dark")).toBe(!before);
  });

  it("starts with the skip link to the main landmark", async () => {
    stubConfig();
    const App = createWebApp({ extensions: [] });

    const { container } = await renderApp(<App />);

    const skip = await screen.findByRole("link", { name: "Skip to content" });
    expect(container.querySelector("a[href], button")).toBe(skip);
    expect(skip.getAttribute("href")).toBe(`#${screen.getByRole("main").id}`);
  });

  it("links Help & docs to the docs base URL of /api/config", async () => {
    stubConfig({ docsBaseUrl: "https://docs.example.org/docs/" });
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    const help = await screen.findByRole("link", { name: "Help & docs" });
    expect(help.getAttribute("href")).toBe("https://docs.example.org/docs");
    expect(help.getAttribute("target")).toBe("_blank");
    expect(help.getAttribute("rel")).toContain("noreferrer");
  });

  it("collapses and expands the sidebar even where the Cookie Store API is missing", async () => {
    stubConfig();
    Reflect.deleteProperty(globalThis, "cookieStore");
    const App = createWebApp({ extensions: [] });

    const { container } = await renderApp(<App />);

    const sidebar = (): string | null | undefined => container.querySelector("[data-slot='sidebar']")?.getAttribute("data-state");
    await screen.findByRole("main");
    expect(sidebar()).toBe("expanded");
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(sidebar()).toBe("collapsed");
  });
});

describe("the app shell while the configuration loads", () => {
  it("shows the loading skeleton as a status until /api/config answers", async () => {
    let answer: (response: Response) => void = () => undefined;
    stubTransport((request) =>
      new URL(request.url).pathname === "/api/config"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : signedIn(request),
    );
    const App = createWebApp({ extensions: [] });

    const { container } = await renderApp(<App />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    expect(screen.queryByRole("main")).toBeNull();
    answer(json(CONFIG_BODY));
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hands a configuration that cannot be loaded to the failure view, not to the shell", async () => {
    stubTransport(() => Promise.reject(new TypeError("fetch failed")));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText("The app could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the app shell in German", () => {
  beforeEach(() => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
  });

  it("names the loading state in German", async () => {
    stubTransport(() => new Promise<Response>(() => undefined));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("names the sidebar trigger, the drawer and its close button in German at 375 px", async () => {
    stubConfig();
    stubMatchMedia(true);
    window.innerWidth = 375;
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    const trigger = await screen.findByRole("button", { name: "Seitenleiste umschalten" });
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).toBeNull();

    fireEvent.click(trigger);

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Start" })).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Hilfe & Doku" })).toBeTruthy();
    expect(document.body.querySelector("[aria-label='Navigation schließen']")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Displays the mobile sidebar.");
    expect(document.body.querySelector("[aria-label='Close']")).toBeNull();
  });

  it("writes the top bar and the Home empty state in German", async () => {
    stubConfig();
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    const header = await screen.findByRole("banner");
    expect(within(header).getByRole("navigation", { name: "Brotkrumennavigation" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: /Zum (dunklen|hellen) Design wechseln/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Zum Inhalt springen" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: `Willkommen bei ${PRODUCT_NAME}` })).toBeTruthy();
    expect(screen.getByText("Lesezeichen mit kurzen, privaten Slugs.")).toBeTruthy();
  });
});

describe("docsUrl", () => {
  it("joins the docs base URL and a route with one slash", () => {
    expect(docsUrl("https://slugbase.app/docs", "/getting-started")).toBe("https://slugbase.app/docs/getting-started");
    expect(docsUrl("https://slugbase.app/docs/", "getting-started")).toBe("https://slugbase.app/docs/getting-started");
  });

  it("is the docs home without a route and the default site without a base", () => {
    expect(docsUrl("https://docs.example.org/docs/")).toBe("https://docs.example.org/docs");
    expect(docsUrl()).toBe("https://slugbase.app/docs");
  });
});
