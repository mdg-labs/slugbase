import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const THEME_CSS_PATH = resolve(import.meta.dirname, "../src/styles/theme.css");

export interface Block {
  prelude: string;
  body: string;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function readThemeCss(): string {
  return readFileSync(THEME_CSS_PATH, "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The blocks at one nesting level: each `prelude { body }`, with the body left unparsed. */
export function parseBlocks(css: string): Block[] {
  const source = stripComments(css);
  const blocks: Block[] = [];
  let depth = 0;
  let start = 0;
  let preludeStart = 0;
  let prelude = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      if (depth === 0) {
        prelude = source.slice(preludeStart, i).trim().replace(/\s+/g, " ");
        start = i + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ prelude, body: source.slice(start, i) });
        preludeStart = i + 1;
      }
    } else if (char === ";" && depth === 0) {
      preludeStart = i + 1;
    }
  }
  if (depth !== 0) {
    throw new Error("unbalanced braces in the stylesheet");
  }
  return blocks;
}

export function findBlock(blocks: readonly Block[], prelude: string): Block {
  const block = blocks.find((candidate) => candidate.prelude === prelude);
  if (block === undefined) {
    throw new Error(`no block with the prelude "${prelude}"`);
  }
  return block;
}

/** The custom properties a block body declares, in order. */
export function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const name = part.slice(0, colon).trim();
    if (name.startsWith("--")) {
      found.set(name, part.slice(colon + 1).trim());
    }
  }
  return found;
}

export type ThemeName = "dark" | "light";

export interface ThemeTokens {
  /** The value of a token with every `var(--other)` chain followed inside the same theme. */
  resolve: (name: string) => string;
  names: () => string[];
  declared: Map<string, string>;
}

function tokensOf(declared: Map<string, string>): ThemeTokens {
  const resolve = (name: string, seen: readonly string[] = []): string => {
    const value = declared.get(`--${name.replace(/^--/, "")}`);
    if (value === undefined) {
      throw new Error(`--${name} is not declared`);
    }
    const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (reference === null) {
      return value;
    }
    const target = reference[1] ?? "";
    if (seen.includes(target)) {
      throw new Error(`--${name} refers back to itself`);
    }
    return resolve(target, [...seen, name]);
  };
  return { resolve: (name) => resolve(name), names: () => [...declared.keys()], declared };
}

/** The dark theme (the `:root, .dark` block), the light theme (`.light`) and the light block used while no class is set. */
export function themeBlocks(css: string): {
  dark: ThemeTokens;
  light: ThemeTokens;
  systemLight: ThemeTokens;
} {
  const blocks = parseBlocks(css);
  const media = findBlock(blocks, "@media (prefers-color-scheme: light)");
  return {
    dark: tokensOf(declarations(findBlock(blocks, ":root, .dark").body)),
    light: tokensOf(declarations(findBlock(blocks, ".light").body)),
    systemLight: tokensOf(declarations(findBlock(parseBlocks(media.body), ":root:not(.dark)").body)),
  };
}

export function parseColor(value: string): Rgba {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? "";
    const full = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (rgba !== null) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  throw new Error(`cannot read the colour "${value}"`);
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgba): number {
  if (color.a !== 1) {
    throw new Error("contrast is measured between opaque colours only");
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2 contrast ratio between two opaque colours. */
export function contrast(foreground: string, background: string): number {
  const a = luminance(parseColor(foreground));
  const b = luminance(parseColor(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
