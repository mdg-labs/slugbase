import { describe, expect, it } from "vitest";
import { clientIpOf, networkPrefixOf, rateLimitKeyOf } from "../../src/http/trusted-proxy.ts";

const SOCKET = "10.0.0.1";

// doc 10 T9: the address a per-IP limit keys on is never one the client wrote.
describe("clientIpOf", () => {
  const cases: readonly {
    name: string;
    hops: number;
    forwardedFor: string | undefined;
    socket?: string | undefined;
    expected: string | undefined;
  }[] = [
    { name: "no trusted hops: the socket address, whatever the header says", hops: 0, forwardedFor: "198.51.100.7", expected: SOCKET },
    { name: "no header: the socket address", hops: 1, forwardedFor: undefined, expected: SOCKET },
    { name: "one hop: the rightmost entry", hops: 1, forwardedFor: "198.51.100.7", expected: "198.51.100.7" },
    {
      name: "one hop: entries a client prepended do not change the result",
      hops: 1,
      forwardedFor: "6.6.6.6, 7.7.7.7, 198.51.100.7",
      expected: "198.51.100.7",
    },
    {
      name: "one hop: a spoofed address does not win over the proxy's entry",
      hops: 1,
      forwardedFor: "203.0.113.200,198.51.100.7",
      expected: "198.51.100.7",
    },
    { name: "two hops: the second entry from the right", hops: 2, forwardedFor: "6.6.6.6, 198.51.100.7, 192.0.2.1", expected: "198.51.100.7" },
    { name: "two hops: a forged leading entry is left of the trusted ones", hops: 2, forwardedFor: "1.1.1.1, 2.2.2.2, 198.51.100.7, 192.0.2.1", expected: "198.51.100.7" },
    { name: "an IPv6 entry", hops: 1, forwardedFor: "2001:db8::1", expected: "2001:db8::1" },
    { name: "surrounding whitespace is ignored", hops: 1, forwardedFor: "6.6.6.6 ,   198.51.100.7  ", expected: "198.51.100.7" },
    { name: "fewer entries than hops: the socket address", hops: 3, forwardedFor: "198.51.100.7, 192.0.2.1", expected: SOCKET },
    { name: "an unparsable entry: the socket address", hops: 1, forwardedFor: "6.6.6.6, unknown", expected: SOCKET },
    { name: "an entry with a port: the socket address", hops: 1, forwardedFor: "198.51.100.7:4711", expected: SOCKET },
    { name: "a markup entry: the socket address", hops: 1, forwardedFor: "<script>alert(1)</script>", expected: SOCKET },
    { name: "an empty entry: the socket address", hops: 1, forwardedFor: "198.51.100.7,", expected: SOCKET },
    { name: "an empty header: the socket address", hops: 1, forwardedFor: "", expected: SOCKET },
    { name: "an unparsable entry at the trusted position, a valid one beyond it: the socket address", hops: 1, forwardedFor: "198.51.100.7, not-an-ip", expected: SOCKET },
    { name: "no socket and no hops: undefined", hops: 0, forwardedFor: "198.51.100.7", socket: undefined, expected: undefined },
  ];

  it.each(cases)("$name", ({ hops, forwardedFor, expected, ...rest }) => {
    const socketAddress = "socket" in rest ? rest.socket : SOCKET;
    expect(clientIpOf({ socketAddress, forwardedFor, trustedHops: hops })).toBe(expected);
  });
});

describe("rateLimitKeyOf", () => {
  const cases: readonly { name: string; address: string; same?: string; different?: string }[] = [
    { name: "an IPv4 address is its own key", address: "198.51.100.7", same: "198.51.100.7", different: "198.51.100.8" },
    { name: "an IPv4-mapped address in dotted form", address: "::ffff:198.51.100.7", same: "198.51.100.7" },
    { name: "an IPv4-mapped address in hex form", address: "::FFFF:c633:6407", same: "198.51.100.7" },
    { name: "an IPv4-mapped address in the long form", address: "0:0:0:0:0:ffff:c633:6407", same: "198.51.100.7" },
    { name: "two addresses of one /64", address: "2001:db8:1:2::1", same: "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", different: "2001:db8:1:3::1" },
    { name: "a compressed run inside the prefix", address: "2001:db8::5:1", same: "2001:db8:0:0:1:2:3:4", different: "2001:db8:0:1::1" },
    { name: "the unspecified address", address: "::", same: "0:0:0:0:9::1", different: "::1:0:0:0:0" },
    { name: "a zone identifier is not part of the key", address: "fe80::1%eth0", same: "fe80::2", different: "fe81::1" },
    { name: "an address that is not an IP is left as it is", address: "unknown", same: "unknown", different: "unknown2" },
  ];

  it.each(cases)("$name", ({ address, same, different }) => {
    if (same !== undefined) {
      expect(rateLimitKeyOf(address)).toBe(rateLimitKeyOf(same));
    }
    if (different !== undefined) {
      expect(rateLimitKeyOf(address)).not.toBe(rateLimitKeyOf(different));
    }
  });

  it("never gives an IPv6 prefix the key of an IPv4 address", () => {
    expect(rateLimitKeyOf("2001:db8:1:2::1")).toContain(":");
    expect(rateLimitKeyOf("2001:db8:1:2::1")).not.toBe("2001:db8:1:2::1");
  });
});

// doc 02 section 2.4: a session keeps a coarse network, never the address.
describe("networkPrefixOf", () => {
  const cases: readonly { address: string | undefined; expected: string | undefined }[] = [
    { address: "203.0.113.57", expected: "203.0.0.0/16" },
    { address: "198.51.100.7", expected: "198.51.0.0/16" },
    { address: "2001:db8:abcd:12:3456:789a:bcde:f012", expected: "2001:db8:abcd::/48" },
    { address: "2001:db8::1", expected: "2001:db8:0::/48" },
    { address: "::1", expected: "0:0:0::/48" },
    { address: "fe80::1%eth0", expected: "fe80:0:0::/48" },
    { address: "::ffff:203.0.113.57", expected: "203.0.0.0/16" },
    { address: "::ffff:cb00:7139", expected: "203.0.0.0/16" },
    { address: "unknown", expected: undefined },
    { address: "", expected: undefined },
    { address: undefined, expected: undefined },
  ];

  it.each(cases)("$address is $expected", ({ address, expected }) => {
    expect(networkPrefixOf(address)).toBe(expected);
  });

  it("keeps nothing of the host part of any address", () => {
    expect(networkPrefixOf("203.0.113.57")).not.toContain("113");
    expect(networkPrefixOf("2001:db8:abcd:12:3456:789a:bcde:f012")).not.toContain("3456");
  });
});
