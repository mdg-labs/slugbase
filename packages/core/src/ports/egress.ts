import type { Port } from "./port.ts";

/** The largest request body the egress port sends, in bytes. */
export const EGRESS_MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface EgressRequestBase {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The time budget for the whole request: every redirect hop included, from resolving to the last byte read. */
  readonly timeoutMs: number;
  /** The most bytes of the decoded response body the port reads; a longer body is refused and the stream aborted. */
  readonly maxBytes: number;
  /**
   * Answers with the first `maxBytes` bytes of a decoded body that is longer, and closes the connection after them, instead of refusing it with
   * `EgressTooLarge`. A declared length above `maxBytes` is not refused either. Every other limit (the time budget, the redirect rules, the
   * content types, the address checks) applies as without it. The caller cannot tell from the response whether it was cut.
   */
  readonly truncateAtMaxBytes?: boolean;
  /**
   * The media types the final response may have, compared without parameters and ignoring case. A response with any
   * other type, or none, is refused with an `EgressError` once its headers arrive and before its body is read.
   * Without the list the type is not checked.
   */
  readonly acceptContentTypes?: readonly string[];
  /**
   * Refuses a redirect from an `https` URL to an `http` one with `EgressBlocked`, before any connection to the `http` target is opened. The
   * request's own URL is not checked by it, and a redirect that keeps the scheme or moves from `http` to `https` is followed as without it.
   */
  readonly refuseHttpDowngrade?: boolean;
}

export interface EgressBodylessRequest extends EgressRequestBase {
  readonly method?: "GET" | "HEAD";
  readonly body?: undefined;
}

export interface EgressPostRequest extends EgressRequestBase {
  readonly method: "POST";
  /** At most `EGRESS_MAX_REQUEST_BODY_BYTES` bytes. */
  readonly body: Uint8Array;
}

export type EgressRequest = EgressBodylessRequest | EgressPostRequest;

export interface EgressResponse {
  /** The URL the response came from: the last one, when redirects were followed. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  /** The decoded body: a `gzip`, `deflate` or `br` content encoding is undone. */
  readonly body: Uint8Array;
}

export type EgressErrorCode = "egress_failed" | "egress_blocked" | "egress_timeout" | "egress_too_large" | "egress_busy";

/**
 * A request the port could not complete. The messages are fixed texts: they
 * never carry a resolved address, a port or the text of a lower-level error, so
 * a member cannot use them to map the internal network (T6). Match on `code`.
 */
export class EgressError extends Error {
  readonly code: EgressErrorCode;

  constructor(code: EgressErrorCode = "egress_failed", message = "The request failed") {
    super(message);
    this.name = "EgressError";
    this.code = code;
  }
}

/** The URL, or an address it resolves to, is not one the server may connect to. */
export class EgressBlocked extends EgressError {
  constructor() {
    super("egress_blocked", "The request was refused");
    this.name = "EgressBlocked";
  }
}

/** The time budget ran out. */
export class EgressTimeout extends EgressError {
  constructor() {
    super("egress_timeout", "The request timed out");
    this.name = "EgressTimeout";
  }
}

/** The request body or the response exceeded its size limit. */
export class EgressTooLarge extends EgressError {
  constructor() {
    super("egress_too_large", "The request or response was too large");
    this.name = "EgressTooLarge";
  }
}

/**
 * The port refused a hop of the request because its share of the host-name lookups has no free slot. That hop was not sent and its target was not judged,
 * so the refusal says nothing about the URL: a caller that stores an answer must not store this one as the target's, and may try again later. A hop
 * that was already answered with a redirect may have been sent, so a caller that repeats a request with side effects must not rely on this error
 * to mean that nothing was sent. The message names no host, address or limit.
 */
export class EgressBusy extends EgressError {
  constructor() {
    super("egress_busy", "The request could not be started now");
    this.name = "EgressBusy";
  }
}

/**
 * All server-initiated HTTP: resolves the host, validates the address, pins the
 * resolved IP and enforces timeouts and size caps (doc 01 section 6). Redirects
 * (301, 302, 303, 307, 308) are followed, at most five per request; every hop
 * passes the same validation as the first request, accepts only `http` and
 * `https` targets and shares the one time budget. A redirect loop, a longer
 * chain and a response outside `acceptContentTypes` fail with an `EgressError`;
 * a hop to an address or scheme the port refuses, or an `https` to `http` hop of a request
 * that sets `refuseHttpDowngrade`, fails with `EgressBlocked`.
 * Failures are `EgressError`s; `EgressBusy` is the one that says the hop it refused was never started (an earlier hop of a redirect chain may have been sent), and every other one says it was tried.
 */
export interface EgressPort extends Port {
  request(request: EgressRequest): Promise<EgressResponse>;
}
