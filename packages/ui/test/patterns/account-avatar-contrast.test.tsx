import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountAvatar } from "../../src/patterns/account-avatar.tsx";
import { contrast, readThemeCss, themeBlocks, type ThemeTokens } from "../theme-css.ts";

// WCAG 2.2 1.4.3: the initials are text, so 4.5:1 against their fill.
const TEXT_MINIMUM = 4.5;

const themes = themeBlocks(readThemeCss());
const THEMES: readonly (readonly [string, ThemeTokens])[] = [
  ["dark", themes.dark],
  ["light", themes.light],
  ["light while the system chooses", themes.systemLight],
];

interface Pair {
  fill: string;
  text: string;
}

// The classes the component really draws for seeds that cover every colour: the fill token and the text token are
// read from them, so the test follows the component rather than a copy of its colour list.
const SEEDS = Array.from({ length: 64 }, (_, index) => `0192f3a0-bbbb-7000-8000-${index.toString(16).padStart(12, "0")}`);

function drawnPairs(): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const seed of SEEDS) {
    const { container, unmount } = render(<AccountAvatar name="Ada Lovelace" seed={seed} />);
    const classes = (container.querySelector('[data-slot="avatar-fallback"]')?.className ?? "").split(/\s+/u);
    const fill = classes.find((name) => name.startsWith("bg-"));
    const text = classes.find((name) => name.startsWith("text-") && name !== "text-xl");
    if (fill === undefined || text === undefined) {
      throw new Error(`the avatar of ${seed} draws no fill and text colour: ${classes.join(" ")}`);
    }
    pairs.set(fill, { fill: `--${fill.slice("bg-".length)}`, text: `--${text.slice("text-".length)}` });
    unmount();
  }
  return [...pairs.values()];
}

describe("the initials of AccountAvatar", () => {
  const pairs = drawnPairs();

  it("draw on eight different fills", () => {
    expect(new Set(pairs.map((pair) => pair.fill)).size).toBe(8);
  });

  describe.each(THEMES)("in the %s theme", (_name, theme) => {
    it.each(Array.from({ length: 8 }, (_, index) => index))("reach 4.5:1 against the fill of colour %i", (index) => {
      const pair = pairs.toSorted((left, right) => left.fill.localeCompare(right.fill))[index];
      if (pair === undefined) {
        throw new Error("fewer than eight avatar colours");
      }
      const ratio = contrast(theme.resolve(pair.text), theme.resolve(pair.fill));
      expect(ratio, `${pair.text} on ${pair.fill}`).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    });
  });
});
