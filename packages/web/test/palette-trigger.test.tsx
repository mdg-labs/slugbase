import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { CATALOGS, LOCALES } from "../src/i18n/locales.ts";
import { PaletteTrigger } from "../src/palette/palette-trigger.tsx";
import "./support.tsx";

vi.mock("../src/palette/palette-state.tsx", () => ({
  usePaletteState: () => ({ open: false, setOpen: () => undefined, triggerRef: { current: null }, focusBack: () => null }),
}));

// The top bar's command trigger (doc 03 "App shell"). jsdom does no layout, so what is checked is the rule that keeps the badge inside
// the button in a browser: the button has a minimum width and no fixed one, so it grows to hold the longest key name of any language, and
// the badge does not shrink.

function ctrlKeyName(locale: (typeof LOCALES)[number]): string {
  return CATALOGS[locale].shortcuts.key.ctrl;
}

describe("the command trigger of the top bar", () => {
  it("holds the whole shortcut in the button for the longest Ctrl key name of the catalogs, in both languages", () => {
    const longest = LOCALES.map(ctrlKeyName).reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length).toBeGreaterThan("⌘".length);
    for (const preference of LOCALES) {
      const view = render(
        <I18nProvider preference={preference}>
          <PaletteTrigger />
        </I18nProvider>,
      );
      const button = screen.getByRole("button", { name: CATALOGS[preference].palette.trigger });
      const keys = Array.from(button.querySelectorAll("kbd")).map((key) => key.textContent);
      expect(keys).toEqual([ctrlKeyName(preference), "K"]);
      const classes = button.className.split(/\s+/);
      expect(classes).toContain("md:min-w-56");
      expect(classes.filter((name) => /^md:w-/.test(name))).toEqual([]);
      expect(button.querySelector("kbd")?.parentElement?.className).toContain("shrink-0");
      view.unmount();
    }
  });
});
