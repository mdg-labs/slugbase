import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../src/index.ts";
import { AppShell, type AppShellLabels, type WorkspaceSwitcherProps } from "../../src/patterns/index.ts";
import { stubBrowserApis, stubCookieStore, stubMatchMedia } from "../support.tsx";

const LABELS: AppShellLabels = {
  skipToContent: "Zum Inhalt springen",
  toggleSidebar: "Seitenleiste umschalten",
  navigation: "Hauptnavigation",
  drawerTitle: "Navigation",
  drawerDescription: "Die Seiten der App.",
  drawerClose: "Navigation schließen",
};

const BASE: WorkspaceSwitcherProps = {
  active: { id: "a", name: "Privat" },
  fallbackName: "Kein Workspace",
  label: "Workspace",
  groupLabel: "Workspaces",
  workspaces: [
    { id: "a", name: "Privat" },
    { id: "b", name: "Team" },
  ],
  listState: "ready",
  loadingLabel: "Lädt",
  errorMessage: "Fehler",
  retryLabel: "Erneut versuchen",
  onRetry: () => undefined,
  emptyMessage: "Keine weiteren",
  onSelect: () => undefined,
  actions: [],
};

function Shell({ switcher }: { readonly switcher: WorkspaceSwitcherProps }): React.ReactElement {
  return (
    <ThemeProvider>
      <AppShell breadcrumb={<span>Start</span>} labels={LABELS} navigation={<span>Navigation</span>} productName="SlugBase" workspaceSwitcher={switcher}>
        <p>Seite</p>
      </AppShell>
    </ThemeProvider>
  );
}

/** What a page that opens the switcher does: it keeps the state and hands it to the shell. */
function Controlled({ onChange }: { readonly onChange?: (open: boolean) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        Wechseln
      </button>
      <Shell
        switcher={{
          ...BASE,
          open,
          onOpenChange: (next) => {
            onChange?.(next);
            setOpen(next);
          },
        }}
      />
    </>
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubCookieStore();
});

describe("the workspace switcher's open state", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  it("opens and closes on its own when it is not given `open`", async () => {
    render(<Shell switcher={BASE} />);

    fireEvent.click(screen.getByRole("button", { name: "Workspace: Privat" }));

    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("opens when its `open` turns true, and says so when it closes", async () => {
    const onChange = vi.fn<(open: boolean) => void>();
    render(<Controlled onChange={onChange} />);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Wechseln" }));

    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Team");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stays shut while `open` is false and asks to open when its button is pressed", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(<Shell switcher={{ ...BASE, open: false, onOpenChange }} />);

    fireEvent.click(screen.getByRole("button", { name: "Workspace: Privat" }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the workspace switcher at 375 px", () => {
  beforeEach(() => {
    stubMatchMedia(true);
    window.innerWidth = 375;
  });

  it("opens the drawer that holds it before it opens its menu", async () => {
    render(<Controlled />);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Wechseln" }));

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(drawer.querySelector("[data-slot='sidebar-header']")).not.toBeNull();
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("lets go of `open` when the drawer is closed under it, so the next drawer does not open the menu", async () => {
    const onChange = vi.fn<(open: boolean) => void>();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Wechseln" }));
    await screen.findByRole("menu");

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.keyDown(document.body, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    });

    expect(onChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Seitenleiste umschalten" }));
    await screen.findByRole("dialog", { name: "Navigation" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
