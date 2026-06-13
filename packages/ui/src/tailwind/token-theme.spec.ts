import { describe, expect, it } from "vitest";
import { resolveTokenColor, slugbaseCssVarColors } from "./token-theme.js";

describe("resolveTokenColor", () => {
  it("maps accent to the design-token CSS variable", () => {
    expect(resolveTokenColor("accent")).toBe("var(--accent)");
  });

  it("exposes canvas and fg tokens bridged from colors-and-type.css", () => {
    expect(slugbaseCssVarColors.canvas).toBe("var(--canvas)");
    expect(slugbaseCssVarColors.fg).toBe("var(--fg)");
  });
});
