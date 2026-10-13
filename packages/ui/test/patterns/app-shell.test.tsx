import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  THEME_STORAGE_KEY,
  ThemeProvider,
} from "../../src/index.ts";
import { AppShell, MAIN_CONTENT_ID, ThemeToggle, type AppShellLabels } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubCookieStore, stubMatchMedia } from "../support.tsx";

const LABELS: AppShellLabels = {
  skipToContent: "Zum Inhalt springen",
  toggleSidebar: "Seitenleiste umschalten",
  navigation: "Hauptnavigation",
  drawerTitle: "Navigation",
  drawerDescription: "Die Seiten der App.",
  drawerClose: "Navigation schließen",
};

function Shell(): React.ReactElement {
  return (
    <ThemeProvider>
      <AppShell
        actions={<ThemeToggle switchToDark="Zum dunklen Design wechseln" switchToLight="Zum hellen Design wechseln" />}
        breadcrumb={
          <Breadcrumb aria-label="Brotkrumen">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Start</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        footer={<a href="https://slugbase.app/docs">Hilfe &amp; Doku</a>}
        labels={LABELS}
        navigation={
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive render={<a aria-current="page" href="/" />}>
                Start
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        }
        productName="SlugBase"
      >
        <h1>Seite</h1>
      </AppShell>
    </ThemeProvider>
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubCookieStore();
});

describe("AppShell on a wide viewport", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  it("has the header, navigation and main landmarks", () => {
    const { container } = render(<Shell />);

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Brotkrumen" })).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.id).toBe(MAIN_CONTENT_ID);
    expect(within(main).getByRole("heading", { name: "Seite" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Seitenleiste umschalten" })).toBeTruthy();
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });

  it("starts with a skip link that points at the page", () => {
    const { container } = render(<Shell />);

    const focusable = [...container.querySelectorAll<HTMLElement>("a[href], button")];
    expect(focusable[0]).toBe(screen.getByRole("link", { name: "Zum Inhalt springen" }));
    expect(focusable[0]?.getAttribute("href")).toBe(`#${MAIN_CONTENT_ID}`);
  });

  it("reaches every control by keyboard: none is taken out of the tab order", () => {
    const { container } = render(<Shell />);

    const controls = [...container.querySelectorAll<HTMLElement>("a[href], button")];
    expect(controls.map((control) => control.textContent || control.getAttribute("aria-label"))).toEqual([
      "Zum Inhalt springen",
      "Start",
      "Hilfe & Doku",
      "Seitenleiste umschalten",
      "Zum dunklen Design wechseln",
    ]);
    for (const control of controls) {
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("collapses the sidebar to icons and expands it again", () => {
    const { container } = render(<Shell />);
    const sidebar = (): string | null | undefined => container.querySelector("[data-slot='sidebar']")?.getAttribute("data-state");

    expect(sidebar()).toBe("expanded");
    fireEvent.click(screen.getByRole("button", { name: "Seitenleiste umschalten" }));
    expect(sidebar()).toBe("collapsed");
    expect(container.querySelector("[data-slot='sidebar']")?.getAttribute("data-collapsible")).toBe("icon");
    fireEvent.click(screen.getByRole("button", { name: "Seitenleiste umschalten" }));
    expect(sidebar()).toBe("expanded");
  });

  it("flips the theme with the toggle, naming the theme it switches to", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<Shell />);
    expect(document.documentElement.classList.contains("light")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Zum dunklen Design wechseln" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: "Zum hellen Design wechseln" })).toBeTruthy();
  });

  it.each(["light", "dark"] as const)("has no accessibility violations in the %s theme", async (theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    const { baseElement } = render(<Shell />);

    expect(document.documentElement.classList.contains(theme)).toBe(true);
    await expectNoViolations(baseElement);
  });
});

describe("AppShell at 375 px", () => {
  beforeEach(() => {
    stubMatchMedia(true);
    window.innerWidth = 375;
  });

  it("keeps the navigation in a drawer that the trigger opens", async () => {
    render(<Shell />);

    expect(screen.queryByRole("link", { name: "Start" })).toBeNull();
    expect(screen.getByRole("main")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Seitenleiste umschalten" }));

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Start" })).toBeTruthy();
  });

  it.each(["light", "dark"] as const)("has no accessibility violations, closed and open, in the %s theme", async (theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    const { baseElement } = render(<Shell />);
    await expectNoViolations(baseElement);

    fireEvent.click(screen.getByRole("button", { name: "Seitenleiste umschalten" }));
    await screen.findByRole("dialog", { name: "Navigation" });

    await expectNoViolations(baseElement);
  });
});

describe("AppShell labels", () => {
  it("names the rail and the drawer's close button from the labels it is given", async () => {
    stubMatchMedia(true);
    const { baseElement } = render(
      <ThemeProvider>
        <AppShell
          breadcrumb={<span>Start</span>}
          labels={LABELS}
          navigation={<SidebarRail label="Rail" />}
          productName="SlugBase"
        >
          <p>Seite</p>
        </AppShell>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Seitenleiste umschalten" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    expect(drawer.getAttribute("aria-describedby")).not.toBeNull();
    expect(baseElement.querySelector("[aria-label='Navigation schließen']")).not.toBeNull();
    expect(baseElement.textContent).not.toContain("Displays the mobile sidebar.");
    expect(baseElement.textContent).not.toContain("Close");
  });
});
