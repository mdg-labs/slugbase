import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { THEME_CSS_PATH, parseBlocks, readThemeCss } from "./theme-css.ts";

const css = readThemeCss();
const requireFromUi = createRequire(resolve(import.meta.dirname, "../package.json"));

function fontFaces(): { family: string; weight: string; src: string; range: string }[] {
  return parseBlocks(css)
    .filter((block) => block.prelude === "@font-face")
    .map((block) => {
      const field = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(block.body)?.[1]?.trim() ?? "";
      return {
        family: field("font-family").replaceAll('"', ""),
        weight: field("font-weight"),
        src: field("src"),
        range: field("unicode-range"),
      };
    });
}

describe("bundled fonts", () => {
  const faces = fontFaces();

  it.each(["IBM Plex Sans", "IBM Plex Mono"])("%s has 400, 500 and 600 in Latin and Latin-Ext", (family) => {
    const own = faces.filter((face) => face.family === family);
    expect(own.map((face) => face.weight).sort()).toEqual(["400", "400", "500", "500", "600", "600"]);
    expect(new Set(own.map((face) => face.range)).size).toBe(2);
  });

  it("serves every font file from an @fontsource package that the package exports", () => {
    expect(faces).toHaveLength(12);
    for (const face of faces) {
      const url = /url\("([^"]+)"\)/.exec(face.src)?.[1] ?? "";
      expect(url).toMatch(/^@fontsource\/ibm-plex-(sans|mono)\/files\/.+-(latin|latin-ext)-(400|500|600)-normal\.woff2$/);
      expect(requireFromUi.resolve(url)).toMatch(/\.woff2$/);
    }
  });

  it("loads fonts swapped in, so text shows before the file arrives", () => {
    for (const block of parseBlocks(css).filter((candidate) => candidate.prelude === "@font-face")) {
      expect(block.body).toContain("font-display: swap");
    }
  });
});

describe("theme.css compiled with Tailwind", () => {
  async function build(candidates: string[]): Promise<string> {
    const compiler = await compile(css, {
      base: dirname(THEME_CSS_PATH),
      loadStylesheet: (id, base) => {
        const path = id === "tailwindcss" ? requireFromUi.resolve("tailwindcss/index.css") : resolve(base, id);
        return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, "utf8") });
      },
    });
    return compiler.build(candidates);
  }

  it("generates semantic colour, folder, type and font utilities from the tokens", async () => {
    const output = await build([
      "bg-primary",
      "text-muted-foreground",
      "border-border",
      "text-success-text",
      "text-primary-text",
      "bg-folder-8",
      "text-sm",
      "text-micro",
      "font-mono",
      "font-heading",
      "rounded-md",
      "ease-standard",
    ]);

    expect(output).toContain("background-color: var(--primary)");
    expect(output).toContain("color: var(--muted-foreground)");
    expect(output).toContain("color: var(--success-text)");
    expect(output).toContain("color: var(--primary-text)");
    expect(output).toContain("background-color: var(--folder-8)");
    expect(output).toContain("font-size: var(--text-micro)");
    expect(output).toContain("font-family: var(--font-mono)");
    expect(output).toContain("font-family: var(--font-heading)");
    expect(output).toContain("border-radius: var(--radius-md)");
  });

  it("applies the dark: variant under the dark class", async () => {
    const output = await build(["dark:bg-card"]);

    expect(output).toMatch(/\.dark\\:bg-card:where\(\.dark, \.dark \*\)/);
  });
});
