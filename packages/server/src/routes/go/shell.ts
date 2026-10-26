import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

// The page the SPA is served from (doc 04 section 2.1): what `/go/<slug>` answers when the browser has to be shown a page, the disambiguation or the not-found one.
// It is read from the web root the composition passes the server, as the static files are, and only if it lies inside that root once symbolic links are resolved.

const INDEX = "index.html";
const NO_SUCH_FILE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

/** The bytes of the SPA's `index.html`, or undefined when the web root has none. */
export type Shell = () => Promise<Uint8Array | undefined>;

/** The shell of the web root, or undefined for a composition that serves no web build. */
export function webShell(webRoot: string | undefined): Shell | undefined {
  if (webRoot === undefined) {
    return undefined;
  }
  return async () => {
    try {
      const root = await realpath(webRoot);
      const index = await realpath(resolve(root, INDEX));
      return index.startsWith(`${root}${sep}`) ? await readFile(index) : undefined;
    } catch (error) {
      if (NO_SUCH_FILE.has((error as { code?: string }).code ?? "")) {
        return undefined;
      }
      throw error;
    }
  };
}
