import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { AuthPage } from "../src/auth/auth-page.tsx";
import { ExtensionsProvider, Slot, type WebExtension } from "../src/extensions/index.ts";
import { FixtureBanner, FixtureDashboardTop, FixtureFooter, fixtureExtension, secondFooter } from "./fixture-extension.tsx";
import { CONFIG_BODY, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.stubGlobal("fetch", (request: Request) => signedIn(request));
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("Slot", () => {
  it("renders the components of the extensions in registration order, without a wrapper element", () => {
    const { container } = render(
      <ExtensionsProvider extensions={[secondFooter("first"), { id: "other" }, secondFooter("second")]}>
        <Slot name="sidebar.footer" />
      </ExtensionsProvider>,
    );

    expect(Array.from(container.children, (child) => `${child.tagName}:${child.textContent}`)).toEqual(["P:first", "P:second"]);
  });

  it("renders nothing for a slot no extension fills", () => {
    const { container } = render(
      <ExtensionsProvider extensions={[fixtureExtension]}>
        <Slot name="dashboard.top" />
      </ExtensionsProvider>,
    );

    expect(container.childNodes).toHaveLength(0);
  });

  it("refuses to run outside the web app", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Slot name="sidebar.footer" />)).toThrow(/inside the web app/);
  });
});

describe("the mounted slots without extensions", () => {
  it("leave the shell and Home exactly as the app renders them", async () => {
    const App = createWebApp({ extensions: [] });

    const { container } = await renderApp(<App />);

    await screen.findByRole("main");
    const main = screen.getByRole("main");
    expect(main.firstElementChild?.getAttribute("data-slot")).toBe("empty");
    expect(main.children).toHaveLength(1);
    const footer = container.querySelector("[data-slot='sidebar-footer']");
    expect(footer?.children).toHaveLength(1);
    expect(footer?.firstElementChild?.getAttribute("data-slot")).toBe("sidebar-menu");
  });
});

describe("a fixture extension", () => {
  it("fills sidebar.footer above Help & docs", async () => {
    const App = createWebApp({ extensions: [fixtureExtension] });

    const { container } = await renderApp(<App />);

    const footer = await waitForFooter(container);
    const text = footer.textContent;
    expect(text.indexOf("Fixture usage meter")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Fixture usage meter")).toBeLessThan(text.indexOf("Help & docs"));
  });

  it("adds a navigation item after Home and a page behind it", async () => {
    const App = createWebApp({ extensions: [fixtureExtension] });

    await renderApp(<App />);

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Home", "Bookmarks", "Folders", "Tags", "Plan & billing"]);
    expect(links[4]?.getAttribute("href")).toBe("/settings/billing");

    fireEvent.click(links[4] as HTMLElement);

    const main = await screen.findByRole("heading", { name: "Fixture billing page" });
    expect(screen.getByRole("main").contains(main)).toBe(true);
    expect(window.location.pathname).toBe("/settings/billing");
    expect(within(nav).getByRole("link", { name: "Plan & billing" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("serves its page when the app opens on it", async () => {
    window.history.replaceState(null, "", "/settings/billing");
    const App = createWebApp({ extensions: [fixtureExtension] });

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { name: "Fixture billing page" })).toBeTruthy();
  });

  it("fills banner.entitlement above the page and dashboard.top above the Home content", async () => {
    const App = createWebApp({
      extensions: [{ id: "notices", slots: { "banner.entitlement": FixtureBanner, "dashboard.top": FixtureDashboardTop } }],
    });

    await renderApp(<App />);

    const main = await screen.findByRole("main");
    const banner = within(main).getByText("Fixture limit banner");
    const top = within(main).getByText("Fixture dashboard notice");
    const home = within(main).getByRole("heading", { level: 1 });
    expect(banner.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(top.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not leave its page or link behind in the next app built without it", async () => {
    createWebApp({ extensions: [fixtureExtension] });
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Home", "Bookmarks", "Folders", "Tags"]);
  });

  it("is refused before anything is requested when its page takes a path of the app", () => {
    const fetch = vi.fn(() => Promise.resolve(json(CONFIG_BODY)));
    vi.stubGlobal("fetch", fetch);
    expect(() => createWebApp({ extensions: [{ id: "home", routes: [{ path: "/", component: FixtureFooter }] }] })).toThrow(
      /route path "\/" of the web extension "home" is already taken/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

const LEGAL_LINKS: WebExtension = {
  id: "legal",
  slots: {
    "auth.footer": () => (
      <nav aria-label="Legal">
        <a href="/imprint">Imprint</a>
      </nav>
    ),
  },
};

const authFooter = (container: HTMLElement): HTMLElement | null => container.querySelector("[data-slot='auth-card-footer']");

describe("auth.footer", () => {
  it("shows an extension's links in the footer of the sign-in page", async () => {
    vi.stubGlobal("fetch", (request: Request) =>
      new URL(request.url).pathname === SESSION_PATH ? Promise.resolve(problem(401, "unauthenticated", "req-session")) : signedIn(request),
    );
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [LEGAL_LINKS] });

    const { container } = await renderApp(<App />);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const footer = authFooter(container);
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByRole("link", { name: "Imprint" }).getAttribute("href")).toBe("/imprint");
  });

  it("leaves the sign-in page without a footer when no extension fills it", async () => {
    vi.stubGlobal("fetch", (request: Request) =>
      new URL(request.url).pathname === SESSION_PATH ? Promise.resolve(problem(401, "unauthenticated", "req-session")) : signedIn(request),
    );
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [fixtureExtension] });

    const { container } = await renderApp(<App />);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(authFooter(container)).toBeNull();
    expect(screen.queryByRole("link", { name: "Imprint" })).toBeNull();
  });

  it("shows on every page that sits in the shared authentication page, and only with an extension", () => {
    const page = (
      <AuthPage productName="SlugBase" title="Create your account">
        <p>Registration form</p>
      </AuthPage>
    );

    const filled = render(<ExtensionsProvider extensions={[LEGAL_LINKS]}>{page}</ExtensionsProvider>);
    expect(within(authFooter(filled.container) as HTMLElement).getByRole("link", { name: "Imprint" })).toBeTruthy();
    filled.unmount();

    const empty = render(<ExtensionsProvider extensions={[]}>{page}</ExtensionsProvider>);
    expect(authFooter(empty.container)).toBeNull();
  });
});

async function waitForFooter(container: HTMLElement): Promise<HTMLElement> {
  await screen.findByRole("main");
  const footer = container.querySelector<HTMLElement>("[data-slot='sidebar-footer']");
  if (footer === null) {
    throw new Error("the sidebar footer did not render");
  }
  return footer;
}
