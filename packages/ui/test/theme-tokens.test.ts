import { describe, expect, it } from "vitest";
import {
  contrast,
  declarations,
  findBlock,
  parseBlocks,
  parseColor,
  readThemeCss,
  themeBlocks,
  type ThemeName,
} from "./theme-css.ts";

const css = readThemeCss();
const themes = themeBlocks(css);
const THEME_NAMES: readonly ThemeName[] = ["dark", "light"];

// The table of doc 03 "Theme tokens": [coss variable, dark, light].
const DOC_TABLE: readonly (readonly [string, string, string])[] = [
  ["background", "#0a0b10", "#f4f5f9"],
  ["sidebar", "#101220", "#ffffff"],
  ["card", "#171a2b", "#ffffff"],
  ["popover", "#1b1f31", "#ffffff"],
  ["muted", "#1e2236", "#f1f2f7"],
  ["accent", "#1e2236", "#f1f2f7"],
  ["foreground", "#eceef6", "#14161f"],
  ["muted-foreground", "#a7adc2", "#4a4f63"],
  ["primary", "#7782f7", "#5b66e8"],
  ["primary-foreground", "#0b0c14", "#ffffff"],
  ["primary-text", "#7782f7", "#4a55d8"],
  ["ring", "#7782f7", "#5b66e8"],
  ["border", "rgba(255,255,255,.10)", "rgba(16,18,32,.11)"],
  ["input", "rgba(255,255,255,.10)", "rgba(16,18,32,.11)"],
  ["success", "#45c98a", "#1f9d68"],
  ["warning", "#e6b24e", "#b8861f"],
  ["destructive", "#f0686b", "#d6494d"],
  ["success-text", "#45c98a", "#17724b"],
  ["warning-text", "#e6b24e", "#8a6100"],
  ["destructive-text", "#f0686b", "#b4282d"],
  ["info", "#56b6e6", "#2b8fc4"],
  ["destructive-button", "#f0686b", "#b4282d"],
  ["destructive-button-foreground", "#0b0c14", "#ffffff"],
];

describe("theme.css tokens", () => {
  it.each(DOC_TABLE)("sets --%s to the documented dark and light values", (name, dark, light) => {
    expect(parseColor(themes.dark.resolve(name))).toEqual(parseColor(dark));
    expect(parseColor(themes.light.resolve(name))).toEqual(parseColor(light));
  });

  it("maps the card and popover foregrounds and the sidebar parts onto the base tokens", () => {
    for (const theme of [themes.dark, themes.light]) {
      expect(theme.resolve("card-foreground")).toBe(theme.resolve("foreground"));
      expect(theme.resolve("popover-foreground")).toBe(theme.resolve("foreground"));
      expect(theme.resolve("sidebar-primary")).toBe(theme.resolve("primary"));
      expect(theme.resolve("sidebar-ring")).toBe(theme.resolve("ring"));
    }
  });

  it("points coss's semantic foreground colours at the AA text variants", () => {
    for (const theme of [themes.dark, themes.light]) {
      for (const name of ["success", "warning", "destructive", "info"]) {
        expect(theme.resolve(`${name}-foreground`)).toBe(theme.resolve(`${name}-text`));
      }
    }
  });

  it("keeps the light block used while no theme class is set identical to the .light block", () => {
    expect([...themes.systemLight.declared]).toEqual([...themes.light.declared]);
  });

  it("declares the same tokens for dark and light", () => {
    expect(themes.light.names().sort()).toEqual(themes.dark.names().sort());
  });

  it("uses 6px as the radius, with the documented small, large and extra-large steps", () => {
    const root = declarations(findBlock(parseBlocks(css), ":root").body);
    expect(root.get("--radius")).toBe("6px");
    const theme = declarations(findBlock(parseBlocks(css), "@theme").body);
    expect(theme.get("--radius-sm")).toBe("4px");
    expect(theme.get("--radius-md")).toBe("var(--radius)");
    expect(theme.get("--radius-lg")).toBe("8px");
    expect(theme.get("--radius-xl")).toBe("12px");
  });

  it("sets the dense type scale", () => {
    const theme = declarations(findBlock(parseBlocks(css), "@theme").body);
    const scale: Record<string, [string, string]> = {
      micro: ["11px", "14px"],
      xs: ["12px", "16px"],
      sm: ["13px", "18px"],
      base: ["14px", "20px"],
      lg: ["15px", "20px"],
      xl: ["18px", "24px"],
      "2xl": ["22px", "28px"],
      "3xl": ["28px", "34px"],
      mono: ["12.5px", "18px"],
    };
    for (const [step, [size, line]] of Object.entries(scale)) {
      expect(theme.get(`--text-${step}`)).toBe(size);
      expect(theme.get(`--text-${step}--line-height`)).toBe(line);
    }
    expect(theme.get("--tracking-wide")).toBe("0.06em");
  });

  it("wires the sans, heading and mono families to IBM Plex", () => {
    const theme = declarations(findBlock(parseBlocks(css), "@theme").body);
    expect(theme.get("--font-sans")).toMatch(/^"IBM Plex Sans",/);
    expect(theme.get("--font-heading")).toBe("var(--font-sans)");
    expect(theme.get("--font-mono")).toMatch(/^"IBM Plex Mono",/);
  });

  it("defines the 110, 170 and 230 ms motion tokens and the easing", () => {
    const root = declarations(findBlock(parseBlocks(css), ":root").body);
    expect(root.get("--duration-micro")).toBe("110ms");
    expect(root.get("--duration-base")).toBe("170ms");
    expect(root.get("--duration-overlay")).toBe("230ms");
    const theme = declarations(findBlock(parseBlocks(css), "@theme").body);
    expect(theme.get("--ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  });

  it("stops animation and transition when the system asks for reduced motion", () => {
    const media = findBlock(parseBlocks(css), "@media (prefers-reduced-motion: reduce)");
    const inner = parseBlocks(media.body);
    const universal = findBlock(inner, "*, ::before, ::after").body;
    expect(universal).toContain("animation-duration: 0.01ms !important");
    expect(universal).toContain("animation-iteration-count: 1 !important");
    expect(universal).toContain("transition-duration: 0.01ms !important");
    const tokens = declarations(findBlock(inner, ":root").body);
    expect([...tokens.values()]).toEqual(["0.01ms", "0.01ms", "0.01ms"]);
  });

  it.each(THEME_NAMES)("defines eight distinct folder tokens in the %s theme", (name) => {
    const values = Array.from({ length: 8 }, (_, index) => parseColor(themes[name].resolve(`folder-${String(index + 1)}`)));
    expect(new Set(values.map((color) => JSON.stringify(color))).size).toBe(8);
    expect(themes[name].names().filter((token) => token.startsWith("--folder-"))).toHaveLength(8);
  });

  it("names no colour outside the two themes and no external host", () => {
    expect(css).not.toMatch(/https?:\/\//);
  });
});

// WCAG 2 AA: 4.5:1 for text (1.4.3), 3:1 for graphical objects and focus indicators (1.4.11).
const TEXT_MINIMUM = 4.5;
const GRAPHIC_MINIMUM = 3;
const SURFACES = ["background", "card", "popover", "sidebar", "muted"] as const;
const SEMANTIC = ["success", "warning", "destructive", "info"] as const;

describe.each(THEME_NAMES)("WCAG AA contrast in the %s theme", (name) => {
  const theme = themes[name];
  const ratio = (foreground: string, background: string): number =>
    contrast(theme.resolve(foreground), theme.resolve(background));

  it.each(SURFACES)("foreground and muted foreground read on %s", (surface) => {
    expect(ratio("foreground", surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    expect(ratio("muted-foreground", surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it.each([
    ["card-foreground", "card"],
    ["popover-foreground", "popover"],
    ["sidebar-foreground", "sidebar"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["primary-foreground", "primary"],
    ["sidebar-primary-foreground", "sidebar-primary"],
    ["sidebar-accent-foreground", "sidebar-accent"],
  ])("%s reads on %s", (foreground, background) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it("the destructive button label reads on the destructive button fill", () => {
    expect(ratio("destructive-button-foreground", "destructive-button")).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it.each(SURFACES)("primary text reads on %s", (surface) => {
    expect(ratio("primary-text", surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it.each(SEMANTIC.flatMap((colour) => SURFACES.map((surface) => [colour, surface] as const)))(
    "%s text variants read on %s",
    (colour, surface) => {
      expect(ratio(`${colour}-text`, surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      expect(ratio(`${colour}-foreground`, surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    },
  );

  it.each(SURFACES)("the focus ring is visible on %s", (surface) => {
    expect(ratio("ring", surface)).toBeGreaterThanOrEqual(GRAPHIC_MINIMUM);
  });

  it.each(Array.from({ length: 8 }, (_, index) => `folder-${String(index + 1)}`))(
    "%s is visible as a graphic on every surface",
    (token) => {
      for (const surface of SURFACES) {
        expect(ratio(token, surface)).toBeGreaterThanOrEqual(GRAPHIC_MINIMUM);
      }
    },
  );
});

// The six accent presets of Q36 (`data-accent` on <html>): each overrides the brand colour and the focus ring.
const ACCENT_PRESETS = ["periwinkle", "violet", "rose", "amber", "green", "teal"] as const;
const ACCENT_TOKENS = ["--primary", "--primary-foreground", "--primary-text", "--ring"];

function accentBlock(theme: ThemeName, preset: string): Map<string, string> {
  const prelude = `.${theme}[data-accent="${preset}"], .${theme} [data-accent="${preset}"]`;
  return declarations(findBlock(parseBlocks(css), prelude).body);
}

describe("the accent presets", () => {
  it("restates the default accent as periwinkle, so a swatch shows it under another accent", () => {
    for (const name of THEME_NAMES) {
      const accent = accentBlock(name, "periwinkle");
      for (const token of ACCENT_TOKENS) {
        expect(parseColor(accent.get(token) ?? "")).toEqual(parseColor(themes[name].resolve(token)));
      }
    }
  });

  it.each(ACCENT_PRESETS)("%s overrides exactly the brand colour, its text colours and the focus ring in both themes", (preset) => {
    for (const name of THEME_NAMES) {
      expect([...accentBlock(name, preset).keys()].sort()).toEqual([...ACCENT_TOKENS].sort());
    }
  });

  it("defines six distinct presets in each theme", () => {
    for (const name of THEME_NAMES) {
      const fills = ACCENT_PRESETS.map((preset) => accentBlock(name, preset).get("--primary"));
      expect(new Set(fills).size).toBe(6);
    }
  });

  describe.each(THEME_NAMES)("in the %s theme", (name) => {
    describe.each(ACCENT_PRESETS)("%s", (preset) => {
      const accent = accentBlock(name, preset);
      const value = (token: string): string => accent.get(token) ?? "";

      it("reads its label on its fill", () => {
        expect(contrast(value("--primary-foreground"), value("--primary"))).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      });

      it.each(SURFACES)("reads as text on %s", (surface) => {
        expect(contrast(value("--primary-text"), themes[name].resolve(surface))).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      });

      it.each(SURFACES)("shows its fill and focus ring as a graphic on %s", (surface) => {
        expect(contrast(value("--ring"), themes[name].resolve(surface))).toBeGreaterThanOrEqual(GRAPHIC_MINIMUM);
        expect(contrast(value("--primary"), themes[name].resolve(surface))).toBeGreaterThanOrEqual(GRAPHIC_MINIMUM);
      });
    });
  });
});

describe("why the semantic text variants exist", () => {
  it("measures the light fills against white below the AA text minimum, as doc 03 states", () => {
    const fills = themes.light;
    expect(contrast(fills.resolve("success"), "#ffffff")).toBeCloseTo(3.45, 2);
    expect(contrast(fills.resolve("warning"), "#ffffff")).toBeCloseTo(3.25, 2);
    expect(contrast(fills.resolve("destructive"), "#ffffff")).toBeCloseTo(4.27, 2);
  });

  it("measures white on the plain destructive fill below the AA text minimum in both themes", () => {
    expect(contrast("#ffffff", themes.dark.resolve("destructive"))).toBeCloseTo(3.04, 2);
    expect(contrast("#ffffff", themes.light.resolve("destructive"))).toBeCloseTo(4.27, 2);
  });

  it("measures the destructive button pair at 6.4:1 in both themes", () => {
    for (const theme of [themes.dark, themes.light]) {
      expect(contrast(theme.resolve("destructive-button-foreground"), theme.resolve("destructive-button"))).toBeCloseTo(6.4, 1);
    }
  });

  it("measures the light text variants at 4.9:1 or more on every light surface", () => {
    for (const colour of SEMANTIC) {
      for (const surface of SURFACES) {
        expect(contrast(themes.light.resolve(`${colour}-text`), themes.light.resolve(surface))).toBeGreaterThanOrEqual(4.9);
      }
    }
  });

  it("measures the light primary fill below the AA text minimum on the page background and the muted surface", () => {
    expect(contrast(themes.light.resolve("primary"), themes.light.resolve("background"))).toBeCloseTo(4.27, 2);
    expect(contrast(themes.light.resolve("primary"), themes.light.resolve("muted"))).toBeCloseTo(4.16, 2);
  });

  it("keeps the dark primary text equal to the fill, which already passes", () => {
    expect(themes.dark.resolve("primary-text")).toBe(themes.dark.resolve("primary"));
  });

  it("keeps the dark text variants equal to the fills, which already pass", () => {
    for (const colour of ["success", "warning", "destructive"]) {
      expect(themes.dark.resolve(`${colour}-text`)).toBe(themes.dark.resolve(colour));
    }
  });
});
