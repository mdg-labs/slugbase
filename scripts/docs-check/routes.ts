import { posix } from "node:path";

/** The first route segments the site keeps for the other content roots (doc 09 section 3.5). */
export const RESERVED_SEGMENTS = ["cloud", "self-hosting", "releases"] as const;

const ROOT_ROUTES: readonly (readonly [root: string, prefix: string])[] = [
  ["docs/user", "/docs"],
  ["docs/self-hosting", "/docs/self-hosting"],
  ["docs/releases", "/docs/releases"],
];

/** The path of a page below its content root, without the extension: `guides/sharing`, `index`. */
function pagePath(file: string, root: string): string {
  const relative = posix.relative(root, file);
  return relative.slice(0, relative.length - posix.extname(relative).length);
}

/**
 * The route the site serves a page at, or null for a file outside the content roots.
 * With `indexAnyCase`, a page named `INDEX` counts as an index page, as it does on a
 * file system or a site that folds case.
 */
export function routeOf(file: string, indexAnyCase = false): string | null {
  for (const [root, prefix] of ROOT_ROUTES) {
    if (!file.startsWith(`${root}/`)) continue;
    const segments = pagePath(file, root).split("/");
    const last = segments[segments.length - 1] ?? "";
    if ((indexAnyCase ? last.toLowerCase() : last) === "index") segments.pop();
    return [prefix, ...segments].join("/");
  }
  return null;
}

/** The first path segment of a page below `docs/user/`, the one the reserved names apply to. */
export function firstUserSegment(file: string): string | null {
  return file.startsWith("docs/user/") ? (pagePath(file, "docs/user").split("/")[0] ?? null) : null;
}
