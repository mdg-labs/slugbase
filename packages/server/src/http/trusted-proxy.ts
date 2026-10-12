import { isIP } from "node:net";

// Client-IP derivation (doc 01 section 4 stage 1, doc 10 T9). The address of
// the client is what the per-IP rate limits key on, so a header the client can
// write must never decide it. Only `X-Forwarded-For` is read, and only the
// entry the configured number of trusted proxies appended: every proxy adds the
// address it received the request from at the right end, so the entry
// `trustedHops` positions from the right is the first one a trusted proxy wrote
// and anything to its left is client-supplied. `X-Real-IP` and `Forwarded` are
// never read.

export interface ClientAddressSources {
  /** The peer address of the TCP connection; undefined when the runtime exposes none. */
  readonly socketAddress: string | undefined;
  /** The value of `X-Forwarded-For`, several header lines already joined by commas. */
  readonly forwardedFor: string | undefined;
  /** `TRUSTED_PROXY_HOPS`. */
  readonly trustedHops: number;
}

/**
 * The client address: the `X-Forwarded-For` entry `trustedHops` positions from
 * the right, or the socket address when there are no trusted hops, the header
 * has fewer entries than hops, or that entry is not an IP address.
 */
export function clientIpOf({ socketAddress, forwardedFor, trustedHops }: ClientAddressSources): string | undefined {
  if (trustedHops > 0 && forwardedFor !== undefined) {
    const entries = forwardedFor.split(",");
    const position = entries.length - trustedHops;
    const entry = position < 0 ? undefined : entries[position]?.trim();
    if (entry !== undefined && isIP(entry) !== 0) {
      return entry;
    }
  }
  return socketAddress;
}
