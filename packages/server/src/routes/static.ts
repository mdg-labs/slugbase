import { realpathSync, statSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import type { ChainContext } from "../http/chain.ts";

// The SPA, served from the directory of its build (doc 01 section 7.1, doc 04
// section 2.1, doc 10 T14): content-hashed assets that never change, index.html
// that is always revalidated, and index.html for a browser navigation to a path
// the app owns. Every request path reaches a file through `readInside`, the one
// place that turns a path into a file: the request path is decoded once, and
// a dot segment, a backslash or a NUL (literal or encoded), a second layer of
// encoding (an encoded `.`, `/`, `\` or NUL left after that decode), a path
// under `/api/` or `/go/` and a malformed encoding refuse the request. A single
// encoded `/` is not refused: it decodes to a separator, so `/assets%2fapp.js`
// names `assets/app.js`. The file that is opened is the real path of the
// candidate, which must lie inside the real web root, so a symlink cannot lead
// out of it.

const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_REVALIDATE = "no-cache";

const INDEX = "index.html";

// The web build puts its content-hashed output below `assets/`, each file named
// `<name>-<hash>.<ext>` with a hash of eight or more base64url characters.
const HASHED_ASSET = /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

// Errors that mean "no such file" for a path that leads nowhere.
const NO_SUCH_FILE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

/** What a request for `path` is, before any file is looked up. */
type Target = { readonly kind: "file"; readonly relative: string } | { readonly kind: "decline" };

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The path below the web root a request names, or a decline: a malformed or
 * double-encoded path, one with a dot segment, a backslash or a NUL once
 * decoded, and anything under `/api/` or `/go/`, which are never the app.
 */
function targetOf(pathname: string): Target {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "decline" };
  }
  // A second layer of encoding is never a file name this build produces.
  if (/%(?:2e|2f|5c|00)/i.test(decoded) || decoded.includes("\0") || decoded.includes("\\")) {
    return { kind: "decline" };
  }
  if (isUnder(decoded, "/api") || isUnder(decoded, "/go")) {
    return { kind: "decline" };
  }
  const segments = decoded.split("/").slice(1);
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return { kind: "decline" };
  }
  return { kind: "file", relative: decoded === "/" ? INDEX : segments.join("/") };
}

/** Whether the request accepts an HTML page: `text/html` listed with a quality above zero. */
function acceptsHtml(accept: string | undefined): boolean {
  return (accept ?? "").split(",").some((range) => {
    const [type = "", ...parameters] = range.split(";").map((part) => part.trim());
    if (type.toLowerCase() !== "text/html") {
      return false;
    }
    const quality = parameters.find((parameter) => /^q=/i.test(parameter));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

interface File {
  readonly body: Uint8Array;
  /** The path below the web root, with `/` separators. */
  readonly path: string;
}

export class WebRootError extends Error {}

function describe(webRoot: string): string {
  return `the web root ${JSON.stringify(webRoot)}`;
}

/**
 * Serves `GET` and `HEAD` for the files below `webRoot`, and index.html for an
 * unknown path that a browser navigation asks for. A request it does not answer
 * is declined by returning undefined, which the chain turns into the `404
 * not_found` problem. Throws `WebRootError` when `webRoot` is not a directory
 * with an index.html in it.
 */
export function serveWebRoot(webRoot: string): (context: ChainContext) => Promise<Response | undefined> {
  let root: string;
  try {
    root = realpathSync(webRoot);
    if (!statSync(root).isDirectory()) {
      throw new WebRootError(`${describe(webRoot)} is not a directory`);
    }
    if (!statSync(resolve(root, INDEX), { throwIfNoEntry: false })?.isFile()) {
      throw new WebRootError(`${describe(webRoot)} has no ${INDEX}`);
    }
  } catch (error) {
    throw error instanceof WebRootError ? error : new WebRootError(`${describe(webRoot)} cannot be read`);
  }

  const inside = (path: string): boolean => path.startsWith(`${root}${sep}`);

  // The only place a request path becomes a file.
  async function readInside(requested: string): Promise<File | undefined> {
    const candidate = resolve(root, requested);
    if (!inside(candidate)) {
      return undefined;
    }
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (error) {
      if (NO_SUCH_FILE.has((error as { code?: string }).code ?? "")) {
        return undefined;
      }
      throw error;
    }
    if (!inside(real)) {
      return undefined;
    }
    const handle = await open(real, "r");
    try {
      if (!(await handle.stat()).isFile()) {
        return undefined;
      }
      return { body: await handle.readFile(), path: relative(root, candidate).split(sep).join("/") };
    } finally {
      await handle.close();
    }
  }

  function answer(file: File, head: boolean): Response {
    const hashed = file.path.startsWith("assets/") && HASHED_ASSET.test(basename(file.path));
    return new Response(head ? null : file.body, {
      status: 200,
      headers: {
        "content-type": MEDIA_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream",
        "cache-control": hashed ? CACHE_IMMUTABLE : CACHE_REVALIDATE,
      },
    });
  }

  return async (context) => {
    const method = context.req.method;
    if (method !== "GET" && method !== "HEAD") {
      return undefined;
    }
    const target = targetOf(new URL(context.req.url).pathname);
    if (target.kind === "decline") {
      return undefined;
    }
    const head = method === "HEAD";
    const file = await readInside(target.relative);
    if (file !== undefined) {
      return answer(file, head);
    }
    if (!acceptsHtml(context.req.header("accept"))) {
      return undefined;
    }
    const index = await readInside(INDEX);
    return index === undefined ? undefined : answer(index, head);
  };
}
