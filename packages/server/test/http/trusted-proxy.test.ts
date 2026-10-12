import { describe, expect, it } from "vitest";
import { clientIpOf } from "../../src/http/trusted-proxy.ts";

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
