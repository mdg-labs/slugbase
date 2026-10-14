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

const IPV6_GROUPS = 8;
const IPV4_MAPPED_GROUP = 0xffff;

// The eight 16-bit groups of an IPv6 address `isIP` accepted: an embedded
// dotted IPv4 tail becomes two groups and `::` the zero groups it stands for.
function ipv6GroupsOf(address: string): number[] | undefined {
  let text = address;
  const zone = text.indexOf("%");
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  const dot = text.lastIndexOf(".");
  if (dot >= 0) {
    const split = text.lastIndexOf(":");
    const octets = text.slice(split + 1).split(".").map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, split + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length < 2 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  if (halves.length > 2 || (halves.length === 1 ? head.length !== IPV6_GROUPS : head.length + tail.length >= IPV6_GROUPS)) {
    return undefined;
  }
  const zeros = new Array<string>(IPV6_GROUPS - head.length - tail.length).fill("0");
  const groups = [...head, ...(halves.length === 2 ? zeros : []), ...tail].map((group) => Number.parseInt(group, 16));
  return groups.length === IPV6_GROUPS && groups.every((group) => Number.isInteger(group)) ? groups : undefined;
}

/**
 * The key a per-IP rate limit counts an address under (doc 10 T9). An
 * IPv4-mapped IPv6 address counts as the IPv4 address it maps, and an IPv6
 * address counts as its /64: one host routes a whole /64, so keying on the full
 * address would give it a fresh bucket for every source address it uses. The
 * full address stays on the request context for logs; only the bucket key is
 * reduced. A value that is not an IP address, such as the placeholder for a
 * request without a socket, is its own key.
 */
export function rateLimitKeyOf(address: string): string {
  if (isIP(address) !== 6) {
    return address;
  }
  const groups = ipv6GroupsOf(address);
  if (groups === undefined) {
    return address;
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === IPV4_MAPPED_GROUP) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

const IPV4_PREFIX_OCTETS = 2;
const IPV6_PREFIX_GROUPS = 3;

/**
 * The coarse network a session keeps instead of an address (doc 02 section 2.4):
 * the first two octets of an IPv4 address as a /16, or the first three groups of
 * an IPv6 address as a /48, in CIDR form with the host bits zero. An IPv4-mapped
 * IPv6 address is the IPv4 address it maps. Undefined for a value that is not an
 * IP address, such as the placeholder of a request without a socket: no prefix is
 * better than a made-up one.
 */
export function networkPrefixOf(address: string | undefined): string | undefined {
  if (address === undefined) {
    return undefined;
  }
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").slice(0, IPV4_PREFIX_OCTETS);
    return `${octets.join(".")}.0.0/16`;
  }
  if (version !== 6) {
    return undefined;
  }
  const mapped = rateLimitKeyOf(address);
  if (isIP(mapped) === 4) {
    return networkPrefixOf(mapped);
  }
  const groups = ipv6GroupsOf(address);
  if (groups === undefined) {
    return undefined;
  }
  return `${groups.slice(0, IPV6_PREFIX_GROUPS).map((group) => group.toString(16)).join(":")}::/48`;
}
