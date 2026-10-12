import type { Port } from "./port.js";

export interface EgressRequest {
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly acceptContentTypes?: readonly string[];
}

export interface EgressResponse {
  /** The URL after the redirects that passed the address checks. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

/**
 * All server-initiated HTTP: resolves the host, validates the address, pins the
 * resolved IP, re-validates redirects and enforces timeouts, size caps and the
 * content-type allowlist (doc 01 section 6).
 */
export interface EgressPort extends Port {
  request(request: EgressRequest): Promise<EgressResponse>;
}
