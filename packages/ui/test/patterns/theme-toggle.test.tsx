import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider } from "../../src/index.ts";
import { ThemeToggle } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

function Toggle(): React.ReactElement {
  return (
    <ThemeProvider>
      <ThemeToggle switchToDark="To dark" switchToLight="To light" />
    </ThemeProvider>
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

describe("ThemeToggle", () => {
  it("is a button named for the theme it switches to, and keeps the choice", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { container } = render(<Toggle />);
    await expectNoViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "To dark" }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "To light" })).toBeTruthy();
    await expectNoViolations(container);
  });

  it("tells the app which theme it switched to", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const onToggle = vi.fn<(next: "light" | "dark") => void>();
    render(
      <ThemeProvider>
        <ThemeToggle onToggle={onToggle} switchToDark="To dark" switchToLight="To light" />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "To dark" }));
    fireEvent.click(screen.getByRole("button", { name: "To light" }));

    expect(onToggle.mock.calls).toEqual([["dark"], ["light"]]);
  });

  it("shows the label in a tooltip when focused", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<Toggle />);

    fireEvent.focus(screen.getByRole("button", { name: "To dark" }));

    const popup = (await screen.findByText("To dark", { selector: "[data-slot='tooltip-viewport'] *" })).closest("[data-slot='tooltip-popup']");
    expect(popup).not.toBeNull();
  });

  it("needs a ThemeProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<ThemeToggle switchToDark="a" switchToLight="b" />)).toThrow(/ThemeProvider/);
  });
});
