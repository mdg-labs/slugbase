import { type Dirent, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_ROOTS, PAGE_EXTENSIONS } from "../../../../scripts/docs-check/contract.ts";
import { routeOf } from "../../../../scripts/docs-check/routes.ts";
import { DOCS_ROUTES } from "./docs-url.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** The paths of every page below a content root, relative to the repository root, with `/` separators. */
function pagesBelow(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(REPO_ROOT, dir), { withFileTypes: true });
  } catch (error) {
    // A content root exists only once it holds a page (docs/releases has none before the first release).
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) return pagesBelow(path);
    return (PAGE_EXTENSIONS as readonly string[]).some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

function servedRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const root of CONTENT_ROOTS) {
    for (const page of pagesBelow(root)) {
      const route = routeOf(page);
      if (route !== null) routes.add(route);
    }
  }
  return routes;
}

/** The `/docs/<route>` path a help route is served at; the empty home route is the docs landing page. */
function pathOfRoute(route: string): string {
  return route === "" ? "/docs" : `/docs/${route}`;
}

/** The help routes that no page of `served` answers, as the paths they should be served at. */
function missingPages(routes: readonly string[], served: ReadonlySet<string>): string[] {
  return routes.map(pathOfRoute).filter((path) => !served.has(path));
}

describe("help routes of the docs registry", () => {
  it("resolves every registered route to a page under the docs content roots", () => {
    const missing = missingPages(Object.values(DOCS_ROUTES), servedRoutes());
    expect(missing, `help routes with no page under the docs content roots: ${missing.join(", ")}`).toEqual([]);
  });

  it("names a route that has no page", () => {
    const served = new Set(["/docs", "/docs/getting-started"]);
    expect(missingPages(["", "getting-started", "no-such-page"], served)).toEqual(["/docs/no-such-page"]);
  });
});
