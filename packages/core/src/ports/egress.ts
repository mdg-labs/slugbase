import type { Port } from "./port.ts";

/** The largest request body the egress port sends, in bytes. */
export const EGRESS_MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface EgressRequestBase {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The time budget for the whole request: resolving, connecting, sending and reading the response. */
  readonly timeoutMs: number;
  /** The most response bytes the port reads; a longer response is refused and the stream aborted. */
  readonly maxBytes: number;
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
  /** The URL the response came from. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

export type EgressErrorCode = "egress_failed" | "egress_blocked" | "egress_timeout" | "egress_too_large";

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
 * All server-initiated HTTP: resolves the host, validates the address, pins the
 * resolved IP and enforces timeouts and size caps (doc 01 section 6). Failures
 * are `EgressError`s. Re-validating redirects and the content-type allowlist
 * are not part of the port yet.
 */
export interface EgressPort extends Port {
  request(request: EgressRequest): Promise<EgressResponse>;
}
