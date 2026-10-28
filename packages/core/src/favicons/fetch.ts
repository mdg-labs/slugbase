import { METADATA_CONTENT_TYPES, METADATA_HTML_MAX_BYTES, parsePageIcons } from "../bookmarks/metadata.ts";
import type { EgressPort } from "../ports/egress.ts";
import { ImageRefused, type ImageCodecPort, type ReencodedIcon } from "../ports/image-codec.ts";
import { PortUnavailable } from "../ports/port.ts";

// The fetch of the favicon of one host through the egress port (doc 02 section 5.4, doc 01 sections 6 and 8.1, doc 10 T6 and T14). Everything the server
// reads here comes from a site the member does not control, so the rules are the strictest the port offers: every request goes through the egress port,
// which refuses a private, loopback, link-local or metadata address, also behind a redirect or a rebinding answer; an icon body is read to at most 64 KiB
// and a longer one is refused, never cut (an image cut short is not the image); only image content types are accepted, so SVG is never fetched as an
// icon; and the bytes are handed to the image codec, which identifies the format from the bytes, refuses a vector format and a declared size above its
// pixel cap, and encodes the PNGs afresh. A candidate that fails in any of these ways is skipped and the next one is tried; a host none of whose
// candidates works has no icon (`none`). A port that is not configured is not a host without an icon: that error is the caller's.

/** The most bytes of an icon the fetch reads (doc 02 section 16); a longer body is refused. */
export const FAVICON_MAX_BYTES = 64 * 1024;

/**
 * The media types an icon response may have. SVG is not among them: a vector icon is refused (doc 10 T14 allows refusing or rasterising, and the
 * server refuses).
 */
export const FAVICON_CONTENT_TYPES: readonly string[] = ["image/x-icon", "image/vnd.microsoft.icon", "image/ico", "image/png", "image/jpeg", "image/gif", "image/webp"];

/** The time one request may take, redirects included. */
export const FAVICON_REQUEST_TIMEOUT_MS = 5_000;

/** The time the whole fetch of a host may take. */
export const FAVICON_TOTAL_TIMEOUT_MS = 20_000;

/** The most `<link rel=icon>` candidates tried after `/favicon.ico`. */
export const FAVICON_LINK_CANDIDATES_MAX = 4;

const SCHEMES = ["https", "http"] as const;

const ICON_HEADERS = { accept: FAVICON_CONTENT_TYPES.join(","), "user-agent": "SlugBase-Favicon" } as const;
const PAGE_HEADERS = { accept: "text/html,application/xhtml+xml", "user-agent": "SlugBase-Favicon" } as const;

export interface FaviconFetchDependencies {
  readonly egress: EgressPort;
  readonly imageCodec: ImageCodecPort;
}

/** What the fetch of a host ended as: the PNGs of its icon, or that no candidate gave a usable one. */
export type FaviconFetchOutcome = ({ readonly kind: "ok" } & ReencodedIcon) | { readonly kind: "none" };

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Fetches the icon of `host`, a lower-case host name: `/favicon.ico` over https and then http, then the `<link rel=icon>` targets of the home page
 * (https first, then http) in document order, at most `FAVICON_LINK_CANDIDATES_MAX` of them, each judged the same way. Never throws for a host, a
 * response or an image it cannot use: those end in `none`. It rejects when the egress port or the image codec is not configured, and for a defect of
 * the codec itself, so the caller retries instead of recording a host without an icon.
 */
export async function fetchFavicon({ egress, imageCodec }: FaviconFetchDependencies, host: string): Promise<FaviconFetchOutcome> {
  const deadline = performance.now() + FAVICON_TOTAL_TIMEOUT_MS;
  const timeLeft = (): number => Math.min(FAVICON_REQUEST_TIMEOUT_MS, Math.floor(deadline - performance.now()));

  const tryIcon = async (url: string): Promise<ReencodedIcon | undefined> => {
    const timeoutMs = timeLeft();
    if (timeoutMs <= 0) {
      return undefined;
    }
    let body: Uint8Array;
    try {
      const response = await egress.request({ url, headers: ICON_HEADERS, timeoutMs, maxBytes: FAVICON_MAX_BYTES, acceptContentTypes: FAVICON_CONTENT_TYPES });
      if (!isSuccess(response.status) || response.body.length === 0) {
        return undefined;
      }
      body = response.body;
    } catch (error) {
      if (error instanceof PortUnavailable) {
        throw error;
      }
      return undefined;
    }
    try {
      return await imageCodec.reencodeIcon(body);
    } catch (error) {
      if (error instanceof ImageRefused) {
        return undefined;
      }
      throw error;
    }
  };

  const homePage = async (): Promise<readonly string[]> => {
    for (const scheme of SCHEMES) {
      const timeoutMs = timeLeft();
      if (timeoutMs <= 0) {
        return [];
      }
      try {
        const response = await egress.request({
          url: `${scheme}://${host}/`,
          headers: PAGE_HEADERS,
          timeoutMs,
          maxBytes: METADATA_HTML_MAX_BYTES,
          truncateAtMaxBytes: true,
          acceptContentTypes: METADATA_CONTENT_TYPES,
        });
        if (isSuccess(response.status)) {
          return parsePageIcons({ body: response.body, contentType: response.contentType, url: response.url });
        }
      } catch (error) {
        if (error instanceof PortUnavailable) {
          throw error;
        }
      }
    }
    return [];
  };

  for (const scheme of SCHEMES) {
    const icon = await tryIcon(`${scheme}://${host}/favicon.ico`);
    if (icon !== undefined) {
      return { kind: "ok", ...icon };
    }
  }
  for (const url of (await homePage()).slice(0, FAVICON_LINK_CANDIDATES_MAX)) {
    const icon = await tryIcon(url);
    if (icon !== undefined) {
      return { kind: "ok", ...icon };
    }
  }
  return { kind: "none" };
}
