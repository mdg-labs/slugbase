import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme, type Theme } from "../src/index.ts";
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

describe("useTheme", () => {
  it("throws outside a ThemeProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow("useTheme must be used inside a ThemeProvider");
  });
});
