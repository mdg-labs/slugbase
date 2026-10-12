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
   * A redirect, answered as the port answers it today: the 3xx response is returned and the target is not
   * followed (`to` is the target the real server would name).
   */
  | { readonly kind: "redirect"; readonly to: string; readonly status?: 301 | 302 | 303 | 307 | 308 }
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
}

export interface FakeEgressResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

// The same cap as EGRESS_MAX_REQUEST_BODY_BYTES in @slugbase/core, which this package cannot import.
const MAX_REQUEST_BODY_BYTES = 1_048_576;

/**
 * An egress port that answers from a script keyed by URL (doc 08 section 3.1),
 * with no network. A URL with no route fails the test loudly instead of being
 * answered. A route can redirect (the 3xx is returned, not followed, as the port
 * does; the target a private address is the redirect-to-a-private-address case),
 * answer with a body larger than the request's `maxBytes`, or time out. It
 * refuses the requests the port refuses before any connection: invalid limits
 * (`RangeError`) and a request body over the cap (`egress_too_large`).
 */
export class FakeEgress {
  readonly available = true;
  /** Every request received, in order. */
  readonly requests: FakeEgressRequest[] = [];
  readonly #routes = new Map<string, FakeEgressRoute>();

  constructor(routes: Readonly<Record<string, FakeEgressRoute>> = {}) {
    for (const [url, route] of Object.entries(routes)) {
      this.script(url, route);
    }
  }

  /** Scripts the answer to `url`, replacing an earlier one. */
  script(url: string, route: FakeEgressRoute): this {
    this.#routes.set(url, route);
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
    const route = this.#routes.get(request.url);
    if (route === undefined) {
      throw new Error(`FakeEgress has no route for ${request.url}`);
    }
    if (route.kind === "blocked") {
      throw new FakeEgressError("egress_blocked");
    }
    if (route.kind === "timeout") {
      throw new FakeEgressError("egress_timeout");
    }
    if (route.kind === "redirect") {
      return { url: request.url, status: route.status ?? 302, contentType: undefined, body: new Uint8Array() };
    }
    const body = route.body ?? new Uint8Array();
    if (method !== "HEAD" && body.length > maxBytes) {
      throw new FakeEgressError("egress_too_large");
    }
    return {
      url: request.url,
      status: route.status ?? 200,
      contentType: route.contentType,
      body: method === "HEAD" ? new Uint8Array() : body,
    };
  }
}
