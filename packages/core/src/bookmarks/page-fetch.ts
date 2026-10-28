import type { EgressPort } from "../ports/egress.ts";
import { METADATA_CONTENT_TYPES, METADATA_HTML_MAX_BYTES, parsePageMetadata, type PageMetadata } from "./metadata.ts";

// The fetch of one page's metadata through the egress port (doc 02 section 5.4, doc 01 section 6, doc 10 T6 and T13), shared by the
// `bookmark.fetchMetadata` job and the synchronous metadata lookup so that the two never disagree on the status they accept, the size they read or
// the content types they parse. The URL is fetched as given (the callers pass a canonical URL, which carries no credentials, which the port refuses),
// at most the first 512 KiB of the decoded body is read, and only `text/html` and `application/xhtml+xml` are accepted. The page is parsed as text
// by `parsePageMetadata`, which executes and follows nothing.

/** What the fetch of one page ended as. */
export type PageFetchOutcome =
  | { readonly kind: "ok"; readonly page: PageMetadata }
  /** The port refused the target: the URL, an address it resolves to, or a redirect hop is not one the server may connect to. */
  | { readonly kind: "blocked" }
  /** Anything else: no connection, a timeout, a status outside 2xx, a page of another type or one that cannot be read. */
  | { readonly kind: "failed" };

const REQUEST_HEADERS = { accept: "text/html,application/xhtml+xml", "user-agent": "SlugBase-Metadata" } as const;

/** The code the egress port gives a target it refuses; matched by value because the fake of the port does not share the class. */
const BLOCKED_CODE = "egress_blocked";

/** Fetches `urlCanonical` through `egress` within `timeoutMs`, redirects included, and never throws: every failure is an outcome. */
export async function fetchPageMetadata(egress: EgressPort, urlCanonical: string, timeoutMs: number): Promise<PageFetchOutcome> {
  try {
    const response = await egress.request({
      url: urlCanonical,
      headers: REQUEST_HEADERS,
      timeoutMs,
      maxBytes: METADATA_HTML_MAX_BYTES,
      truncateAtMaxBytes: true,
      acceptContentTypes: METADATA_CONTENT_TYPES,
    });
    if (response.status < 200 || response.status >= 300) {
      return { kind: "failed" };
    }
    const page = parsePageMetadata({ body: response.body, contentType: response.contentType, url: response.url });
    return page === undefined ? { kind: "failed" } : { kind: "ok", page };
  } catch (error) {
    return { kind: (error as { code?: unknown } | null)?.code === BLOCKED_CODE ? "blocked" : "failed" };
  }
}
