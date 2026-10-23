// The URL of a bookmark (doc 02 section 5.1, doc 05 section 2.4, doc 10 T12 and T13): what is stored, the canonical form
// that detects duplicates and keys the metadata and AI caches, and the host derived from it. Only `http` and `https`
// are ever stored; the module refuses everything else before a value reaches a table (`javascript:`, `data:`,
// `file:`, `vbscript:`, a scheme-relative value, an empty one), so a destination `/go` redirects to is never a script
// or a local file. The `bookmarks` table refuses the same values with a CHECK of its own.
//
// The stored form is the WHATWG serialisation of the parsed URL: lower-case scheme and host, an internationalised
// host name in punycode, the default port of the scheme left out, dot segments resolved and the fragment kept. The
// canonical form is that URL without its fragment, its credentials, its `utm_*`, `fbclid` and `gclid` parameters and
// the trailing slash of its path, with the remaining parameters sorted. Credentials are left out of the canonical
// form because it is the key of caches that other parts of the product store and send on, and a password has no
// business there.

/** The longest URL a bookmark holds, in characters (doc 02 section 5.1). */
export const BOOKMARK_URL_MAX_LENGTH = 2048;

export type BookmarkUrlRefusal =
  /** Nothing, or only whitespace. */
  | "empty"
  /** More than `BOOKMARK_URL_MAX_LENGTH` characters, as given or once normalised. */
  | "too_long"
  /** Not an `http` or `https` URL: another scheme, a scheme-relative value or a value with no scheme. */
  | "not_http"
  /** An `http` or `https` URL that does not parse: no host, a forbidden character in the host, a control character. */
  | "malformed";

export interface BookmarkUrl {
  /** The URL as stored. */
  readonly url: string;
  /** The canonical form: the key of duplicate detection and of the metadata and AI caches. */
  readonly canonical: string;
  /** The host name of the canonical form, lower case and in punycode, with the brackets of an IPv6 address. */
  readonly host: string;
}

export type BookmarkUrlResult =
  | { readonly ok: true; readonly value: BookmarkUrl }
  | { readonly ok: false; readonly reason: BookmarkUrlRefusal };

const EDGE_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
const HTTP_PREFIX = /^https?:\/\//i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const TRACKING_PARAMETER = /^(?:utm_.*|fbclid|gclid)$/i;

function refuse(reason: BookmarkUrlRefusal): BookmarkUrlResult {
  return { ok: false, reason };
}

function parameterName(pair: string): string {
  const raw = pair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The query of a URL without tracking parameters and with the rest sorted by name, then by value; empty when nothing is left. */
function canonicalQuery(search: string): string {
  const pairs = search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && !TRACKING_PARAMETER.test(parameterName(pair)));
  pairs.sort((a, b) => {
    const [nameA = "", ...valueA] = a.split("=");
    const [nameB = "", ...valueB] = b.split("=");
    return compareCodeUnits(nameA, nameB) || compareCodeUnits(valueA.join("="), valueB.join("="));
  });
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/**
 * Normalises `input` for storage and computes its canonical form and host, or says why it is refused. Leading and
 * trailing whitespace is dropped; nothing else of the value is guessed at: a value that does not begin with
 * `http://` or `https://` is not an `http` or `https` URL.
 */
export function normalizeBookmarkUrl(input: string): BookmarkUrlResult {
  const given = input.replace(EDGE_WHITESPACE, "");
  if (given === "") {
    return refuse("empty");
  }
  if (given.length > BOOKMARK_URL_MAX_LENGTH) {
    return refuse("too_long");
  }
  if (!HTTP_PREFIX.test(given)) {
    return refuse("not_http");
  }
  if (CONTROL_CHARACTER.test(given) || !URL.canParse(given)) {
    return refuse("malformed");
  }
  const parsed = new URL(given);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    return refuse("malformed");
  }
  const url = parsed.href;
  if (url.length > BOOKMARK_URL_MAX_LENGTH) {
    return refuse("too_long");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const canonical = `${parsed.protocol}//${parsed.host}${path}${canonicalQuery(parsed.search)}`;
  return { ok: true, value: { url, canonical, host: parsed.hostname } };
}
