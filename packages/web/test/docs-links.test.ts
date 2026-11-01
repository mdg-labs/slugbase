import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// No component writes a documentation address by hand: every help link goes through docsUrl() (doc 09 section 3.5). The
// docs folder holds the default address and the registry of routes, so it is the one place that may name them.

const SRC = resolve(import.meta.dirname, "../src");
const ALLOWED = join(SRC, "docs");
const IMPORT_FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s+"[^"]*";?/m;
const HAND_WRITTEN = [/slugbase\.app\/docs/i, /\/docs\//i];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return path === ALLOWED ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("documentation addresses in packages/web", () => {
  it("are written by no file outside src/docs", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => {
      const text = readFileSync(file, "utf8").replace(new RegExp(IMPORT_FROM.source, "gm"), "");
      return HAND_WRITTEN.some((pattern) => pattern.test(text));
    });
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });

  it("are not mistaken for the path of an import of the docs folder", () => {
    expect(IMPORT_FROM.test('import { useDocsUrl } from "../docs/docs-url.ts";')).toBe(true);
  });

  it("are found by the pattern in the literals it guards against", () => {
    for (const literal of ['"https://slugbase.app/docs"', "`${base}/docs/getting-started`", '"/docs/self-hosting"']) {
      expect(HAND_WRITTEN.some((pattern) => pattern.test(literal))).toBe(true);
    }
  });
});
