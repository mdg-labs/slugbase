import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACCENT_STORAGE_KEY, THEME_STORAGE_KEY, ThemeProvider, useTheme, type Accent, type Theme } from "../src/index.ts";
import "./support.tsx";

interface SystemTheme {
  setDark: (dark: boolean) => void;
}

/** A controllable `prefers-color-scheme: dark` media query. */
function stubSystemTheme(initialDark: boolean): SystemTheme {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return dark && query.includes("prefers-color-scheme: dark");
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    setDark(next) {
      dark = next;
      act(() => {
        listeners.forEach((listener) => {
          listener();
        });
      });
    },
  };
}

function Probe(): React.ReactElement {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <p data-testid="state">{`${theme}/${resolvedTheme}`}</p>
      {(["light", "dark", "system"] as const satisfies readonly Theme[]).map((choice) => (
        <button key={choice} onClick={() => { setTheme(choice); }} type="button">
          {choice}
        </button>
      ))}
    </div>
  );
}

function state(): string | null {
  return screen.getByTestId("state").textContent;
}

function rootClasses(): string[] {
  return [...document.documentElement.classList];
}

describe("ThemeProvider", () => {
  it("defaults to the system preference and follows it while the choice is system", () => {
    const system = stubSystemTheme(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(state()).toBe("system/dark");
    expect(rootClasses()).toEqual(["dark"]);

    system.setDark(false);

    expect(state()).toBe("system/light");
    expect(rootClasses()).toEqual(["light"]);
  });

  it("applies and remembers an explicit choice, ignoring the system preference", () => {
    const system = stubSystemTheme(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "light" }));

    expect(state()).toBe("light/light");
    expect(rootClasses()).toEqual(["light"]);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    system.setDark(false);
    system.setDark(true);

    expect(rootClasses()).toEqual(["light"]);
  });

  it("restores the stored choice on the next load", () => {
    stubSystemTheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(state()).toBe("dark/dark");
    expect(rootClasses()).toEqual(["dark"]);
  });

  it("ignores a stored value that is not a theme", () => {
    stubSystemTheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "midnight");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(state()).toBe("system/light");
  });

  it("keeps working when storage cannot be read or written", () => {
    stubSystemTheme(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(state()).toBe("system/dark");

    fireEvent.click(screen.getByRole("button", { name: "light" }));

    expect(state()).toBe("light/light");
    expect(rootClasses()).toEqual(["light"]);
  });

  it("uses the given default and storage key", () => {
    stubSystemTheme(true);
    render(
      <ThemeProvider defaultTheme="light" storageKey="custom-theme">
        <Probe />
      </ThemeProvider>,
    );

    expect(state()).toBe("light/light");

    fireEvent.click(screen.getByRole("button", { name: "dark" }));

    expect(window.localStorage.getItem("custom-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

function AccentProbe(): React.ReactElement {
  const { accent, setAccent } = useTheme();
  return (
    <div>
      <p data-testid="accent">{accent ?? "none"}</p>
      {(["teal", null] as const satisfies readonly (Accent | null)[]).map((choice) => (
        <button key={choice ?? "default"} onClick={() => { setAccent(choice); }} type="button">
          {choice ?? "default"}
        </button>
      ))}
    </div>
  );
}

describe("the accent", () => {
  it("shows no accent attribute until one is chosen, then sets and removes data-accent and remembers it", () => {
    stubSystemTheme(false);
    render(
      <ThemeProvider>
        <AccentProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("accent").textContent).toBe("none");
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "teal" }));

    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");

    fireEvent.click(screen.getByRole("button", { name: "default" }));

    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it("restores the stored accent, and ignores a stored value that is not a preset", () => {
    stubSystemTheme(false);
    window.localStorage.setItem(ACCENT_STORAGE_KEY, "rose");
    const first = render(
      <ThemeProvider>
        <AccentProbe />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute("data-accent")).toBe("rose");
    first.unmount();
    document.documentElement.removeAttribute("data-accent");

    window.localStorage.setItem(ACCENT_STORAGE_KEY, "#ff0000");
    render(
      <ThemeProvider>
        <AccentProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("accent").textContent).toBe("none");
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });
});

describe("useTheme", () => {
  it("throws outside a ThemeProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow("useTheme must be used inside a ThemeProvider");
  });
});
