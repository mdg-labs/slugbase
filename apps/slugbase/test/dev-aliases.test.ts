import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveConfig, type Alias } from "vite";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";

// The dev server reads `@slugbase/web` and `@slugbase/ui` from their sources (doc 08 section 1.3).
// A subpath that still resolves to the package's `dist` loads a second copy of the source module
// beside the aliased one, and the two copies hold separate React contexts: the app shell then fails
// with "useSidebar must be used within a SidebarProvider". Every subpath the web app imports and
// the package exports from `dist` therefore needs a serve-mode alias to its source.

const APP = resolve(import.meta.dirname, "..");
const PACKAGES = resolve(APP, "../../packages");
const ALIASED = [
  { name: "@slugbase/ui", directory: "ui" },
  { name: "@slugbase/web", directory: "web" },
];

type Condition = string | { [key: string]: Condition };

function targets(condition: Condition): string[] {
  return typeof condition === "string" ? [condition] : Object.values(condition).flatMap(targets);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === "node_modules" || entry === "dist" ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function importedSpecifiers(): Set<string> {
  const found = new Set<string>();
  const pattern = /\b(?:from|import)\s*\(?\s*["'](@slugbase\/[^"']+)["']/g;
  for (const root of [resolve(PACKAGES, "web/src"), resolve(APP, "src")]) {
    for (const file of sourceFiles(root)) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        found.add(match[1] as string);
      }
    }
  }
  return found;
}

// The alias a specifier resolves through, the way Vite's alias plugin applies it.
function aliasFor(aliases: readonly Alias[], specifier: string): string | undefined {
  for (const { find, replacement } of aliases) {
    if (typeof find === "string" ? find === specifier : find.test(specifier)) {
      return replacement;
    }
  }
  return undefined;
}

// Each `dist` entry of a package's `exports` that the web app imports, with the source it must map to.
function distSubpaths(): { specifier: string; source: string }[] {
  const imported = importedSpecifiers();
  const subpaths: { specifier: string; source: string }[] = [];
  for (const { name, directory } of ALIASED) {
    const manifest = JSON.parse(readFileSync(resolve(PACKAGES, directory, "package.json"), "utf8")) as {
      exports: Record<string, Condition>;
    };
    for (const [subpath, condition] of Object.entries(manifest.exports)) {
      const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`;
      const dist = targets(condition).find((target) => /^\.\/dist\/.+\.js$/.test(target));
      if (dist === undefined || !imported.has(specifier)) {
        continue;
      }
      subpaths.push({ specifier, source: resolve(PACKAGES, directory, dist.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")) });
    }
  }
  return subpaths;
}

describe("dev server aliases", () => {
  it("finds the subpaths the web app imports from dist", () => {
    expect(distSubpaths().map((entry) => entry.specifier)).toEqual(
      expect.arrayContaining(["@slugbase/ui", "@slugbase/ui/patterns"]),
    );
  });

  it(
    "aliases every dist subpath of the UI and the web app to its source when serving",
    async () => {
      const serve = await resolveConfig({ configFile: resolve(APP, "vite.config.ts"), logLevel: "silent" }, "serve");
      const aliases = serve.resolve.alias;
      const unaliased: string[] = [];
      for (const { specifier, source } of distSubpaths()) {
        expect(existsSync(source), `${source} exists`).toBe(true);
        if (aliasFor(aliases, specifier) !== source) {
          unaliased.push(specifier);
        }
      }
      expect(unaliased).toEqual([]);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the packages as published when building",
    async () => {
      const build = await resolveConfig({ configFile: resolve(APP, "vite.config.ts"), logLevel: "silent" }, "build");
      const own = build.resolve.alias.filter((alias) => String(alias.find).includes("slugbase"));
      expect(own).toEqual([]);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );
});
