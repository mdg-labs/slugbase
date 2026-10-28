// The package builds with neither DOM nor Node typings, which is where `URL` is declared; the runtime has it.
interface ParsedUrl {
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  hash: string;
}
declare const URL: {
  new (input: string, base?: string | ParsedUrl): ParsedUrl;
  canParse(input: string): boolean;
};

export type FakeEgressErrorCode = "egress_failed" | "egress_blocked" | "egress_timeout" | "egress_too_large";

/**
 * The error a `FakeEgress` throws. It carries the same `name`, `code` and fixed
 * message as the errors of the egress port in `@slugbase/core`; this package
 * imports no workspace package, so match on `code`.
 */
export class FakeEgressError extends Error {
  readonly code: FakeEgressErrorCode;

  constructor(code: FakeEgressErrorCode) {
    const named = {
      egress_failed: ["EgressError", "The request failed"],
      egress_blocked: ["EgressBlocked", "The request was refused"],
      egress_timeout: ["EgressTimeout", "The request timed out"],
      egress_too_large: ["EgressTooLarge", "The request or response was too large"],
    } as const;
    super(named[code][1]);
    this.name = named[code][0];
    this.code = code;
  }
}

/** What a request to a scripted URL answers. */
export type FakeEgressRoute =
  | {
      readonly kind?: "response";
      readonly status?: number;
      readonly contentType?: string;
      readonly body?: Uint8Array;
    }
  /**
   * A redirect the port follows: `to` is the `Location` the real server would name, absolute or relative to the
   * URL that answered. Each hop is validated like the first request.
   */
  | { readonly kind: "redirect"; readonly to: string }
  /** A destination the real port refuses (a private address, a bad scheme): the request fails with a blocked error. */
  | { readonly kind: "blocked" }
  | { readonly kind: "timeout" };

export interface FakeEgressRequest {
  readonly url: string;
  readonly method?: "GET" | "HEAD" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly truncateAtMaxBytes?: boolean;
  readonly acceptContentTypes?: readonly string[];
}

export interface FakeEgressResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

// The same caps as EGRESS_MAX_REQUEST_BODY_BYTES and the redirect limit of the port in @slugbase/core, which this package cannot import.
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_REDIRECTS = 5;

// Every IPv4 range the port refuses (IANA special-purpose registry), as [base address, prefix length].
const NON_PUBLIC_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function inRange(address: number, [base, prefix]: readonly [number, number]): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((address & mask) >>> 0) === ((base & mask) >>> 0);
}

function isPublicV4(address: number): boolean {
  return !NON_PUBLIC_V4.some((range) => inRange(address, range));
}

// The host of a URL object is already canonical: IPv4 in dotted form whatever notation was typed, IPv6 in
// lower-case groups with the longest zero run compressed. Only the global unicast block 2000::/3 is public.
function isPublicHost(hostname: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const [a = 0, b = 0, c = 0, d = 0] = hostname.split(".").map(Number);
    return isPublicV4(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  }
  if (!hostname.startsWith("[")) {
    return true;
  }
  const halves = hostname.slice(1, -1).split("::");
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length < 2 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  const words = [...head, ...Array.from({ length: halves.length < 2 ? 0 : 8 - head.length - tail.length }, () => "0"), ...tail].map(
    (word) => Number.parseInt(word, 16),
  );
  if (words.length !== 8 || words.some((word) => Number.isNaN(word))) {
    return false;
  }
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return isPublicV4(((w6 << 16) | w7) >>> 0);
  }
  if ((w0 & 0xe000) !== 0x2000) {
    return false;
  }
  if (w0 === 0x2002) {
    return isPublicV4(((w1 << 16) | w2) >>> 0);
  }
  const reserved =
    (w0 === 0x2001 && (w1 === 0 || (w1 === 2 && w2 === 0) || w1 === 0x0db8 || (w1 & 0xfff0) === 0x10)) ||
    (w0 === 0x3fff && (w1 & 0xf000) === 0);
  return !reserved;
}
function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

// The checks the port makes of every hop's URL before any connection: http or https, no credentials, and an IP
// literal that is a public address. A host name is the script's to decide: script a route as `blocked`.
function checkDestination(text: string): ParsedUrl {
  let url: ParsedUrl;
  try {
    url = new URL(text);
  } catch {
    throw new FakeEgressError("egress_blocked");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    !isPublicHost(url.hostname)
  ) {
    throw new FakeEgressError("egress_blocked");
  }
  return url;
}

function withoutFragment(url: ParsedUrl): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

/**
 * An egress port that answers from a script keyed by URL (doc 08 section 3.1),
 * with no network. A URL with no route fails the test loudly instead of being
 * answered. It does what the port does: a redirect route is followed with the
 * hop limit, loop detection and per-hop validation of the port (a target with a
 * scheme other than http and https, with credentials, or an IP literal that is
 * not a public address is refused), the content-type allowlist is applied to
 * the final response before its body, and a body larger than the request's
 * `maxBytes` is refused, or cut to `maxBytes` when the request sets `truncateAtMaxBytes`. A route can also time out. It refuses the requests the
 * port refuses before any connection: invalid limits (`RangeError`) and a
 * request body over the cap (`egress_too_large`).
 */
export class FakeEgress {
  readonly available = true;
  /** Every request received, in order. */
  readonly requests: FakeEgressRequest[] = [];
  /** Every URL the fake answered or tried, redirect hops included, in order; a refused target is not in it. */
  readonly fetched: string[] = [];
  readonly #routes = new Map<string, FakeEgressRoute>();

  constructor(routes: Readonly<Record<string, FakeEgressRoute>> = {}) {
    for (const [url, route] of Object.entries(routes)) {
      this.script(url, route);
    }
  }

  /** Scripts the answer to `url`, replacing an earlier one. A URL is matched in its normalised form without the fragment, as a request URL is. */
  script(url: string, route: FakeEgressRoute): this {
    this.#routes.set(URL.canParse(url) ? withoutFragment(new URL(url)) : url, route);
    return this;
  }

  request(request: FakeEgressRequest): Promise<FakeEgressResponse> {
    this.requests.push(request);
    try {
      return Promise.resolve(this.#answer(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new FakeEgressError("egress_failed"));
    }
  }

  #answer(request: FakeEgressRequest): FakeEgressResponse {
    const { timeoutMs, maxBytes } = request;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("An egress request needs a positive time budget and a maximum size");
    }
    const method = request.method ?? "GET";
    const requestBody = method === "POST" ? request.body : undefined;
    if (method === "POST" && requestBody === undefined) {
      throw new RangeError("A POST egress request needs a body");
    }
    if (requestBody !== undefined && requestBody.length > MAX_REQUEST_BODY_BYTES) {
      throw new FakeEgressError("egress_too_large");
    }
    const accepted =
      request.acceptContentTypes === undefined ? undefined : new Set(request.acceptContentTypes.map(mediaType));
    let url = checkDestination(request.url);
    const visited = new Set([withoutFragment(url)]);
    for (let redirects = 0; ; redirects += 1) {
      const route = this.#routes.get(withoutFragment(url));
      if (route === undefined) {
        throw new Error(`FakeEgress has no route for ${url.href}`);
      }
      this.fetched.push(withoutFragment(url));
      if (route.kind === "blocked") {
        throw new FakeEgressError("egress_blocked");
      }
      if (route.kind === "timeout") {
        throw new FakeEgressError("egress_timeout");
      }
      if (route.kind === "redirect") {
        let next: ParsedUrl;
        try {
          next = checkDestination(new URL(route.to, url).href);
        } catch (error) {
          throw error instanceof FakeEgressError ? error : new FakeEgressError("egress_blocked");
        }
        if (visited.has(withoutFragment(next)) || redirects === MAX_REDIRECTS) {
          throw new FakeEgressError("egress_failed");
        }
        visited.add(withoutFragment(next));
        url = next;
        continue;
      }
      if (accepted !== undefined && !accepted.has(mediaType(route.contentType))) {
        throw new FakeEgressError("egress_failed");
      }
      const body = route.body ?? new Uint8Array();
      if (method !== "HEAD" && body.length > maxBytes && request.truncateAtMaxBytes !== true) {
        throw new FakeEgressError("egress_too_large");
      }
      return {
        url: url.href,
        status: route.status ?? 200,
        contentType: route.contentType,
        body: method === "HEAD" ? new Uint8Array() : body.subarray(0, maxBytes),
      };
    }
  }
}
