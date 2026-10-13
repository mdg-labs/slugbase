import { describe, expect, it } from "vitest";
import { formatAddress, isPublicAddressText, parseAddress, parseIPv4, parseIPv6 } from "../src/egress/address.ts";

// T6: every address below is classified by the address it denotes, whatever its notation.

const NON_PUBLIC: readonly (readonly [string, string])[] = [
  ["0.0.0.0", "unspecified"],
  ["0.1.2.3", "this network"],
  ["10.0.0.1", "private 10/8"],
  ["10.255.255.255", "private 10/8 end"],
  ["172.16.0.1", "private 172.16/12"],
  ["172.31.255.255", "private 172.16/12 end"],
  ["192.168.1.1", "private 192.168/16"],
  ["100.64.0.1", "CGNAT"],
  ["100.127.255.255", "CGNAT end"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback end"],
  ["169.254.169.254", "cloud metadata"],
  ["169.254.0.1", "link-local"],
  ["192.0.0.1", "IETF assignments"],
  ["192.0.2.1", "documentation TEST-NET-1"],
  ["198.51.100.1", "documentation TEST-NET-2"],
  ["203.0.113.1", "documentation TEST-NET-3"],
  ["192.88.99.1", "6to4 relay"],
  ["198.18.0.1", "benchmarking"],
  ["198.19.255.255", "benchmarking end"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast end"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "broadcast"],
  ["::", "IPv6 unspecified"],
  ["::1", "IPv6 loopback"],
  ["fc00::1", "IPv6 unique-local"],
  ["fd12:3456:789a::1", "IPv6 unique-local"],
  ["fe80::1", "IPv6 link-local"],
  ["febf::1", "IPv6 link-local end"],
  ["fec0::1", "IPv6 site-local"],
  ["ff02::1", "IPv6 multicast"],
  ["ff00::", "IPv6 multicast start"],
  ["2001:db8::1", "IPv6 documentation"],
  ["3fff::1", "IPv6 documentation (RFC 9637)"],
  ["2001::1", "Teredo"],
  ["2001:2::1", "IPv6 benchmarking"],
  ["2001:10::1", "ORCHID"],
  ["64:ff9b::7f00:1", "NAT64 to loopback"],
  ["100::1", "IPv6 discard"],
  ["::127.0.0.1", "IPv4-compatible loopback"],
  ["0:0:0:0:0:0:0:1", "IPv6 loopback, long form"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
  ["::FFFF:7F00:0001", "IPv4-mapped loopback, upper case"],
  ["0:0:0:0:0:ffff:127.0.0.1", "IPv4-mapped loopback, long form"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
  ["::ffff:a9fe:a9fe", "IPv4-mapped metadata address, hex form"],
  ["::ffff:10.0.0.1", "IPv4-mapped private"],
  ["::ffff:0:0", "IPv4-mapped unspecified"],
  ["2002:7f00:1::1", "6to4 of loopback"],
  ["2002:a9fe:a9fe::", "6to4 of the metadata address"],
  ["2130706433", "decimal loopback"],
  ["017700000001", "octal loopback"],
  ["0x7f000001", "hexadecimal loopback"],
  ["0x7f.0.0.1", "hexadecimal first part"],
  ["0177.0.0.1", "octal first part"],
  ["127.1", "short form loopback"],
  ["127.0.1", "three-part loopback"],
  ["0xa9.0xfe.0xa9.0xfe", "hexadecimal metadata address"],
  ["2852039166", "decimal metadata address"],
  ["0", "decimal zero"],
  ["not an address", "text"],
  ["", "empty"],
  ["fe80::1%eth0", "zone id"],
  ["1.2.3.4.5", "five parts"],
  ["256.1.1.1", "part out of range"],
  ["::1::2", "two compressions"],
  ["1:2:3:4:5:6:7:8:9", "nine groups"],
  ["::ffff:1.2.3", "short IPv4 tail"],
  ["09.1.1.1", "invalid octal"],
];

const PUBLIC: readonly (readonly [string, string])[] = [
  ["8.8.8.8", "public IPv4"],
  ["1.1.1.1", "public IPv4"],
  ["93.184.216.34", "public IPv4"],
  ["100.63.255.255", "just below CGNAT"],
  ["100.128.0.1", "just above CGNAT"],
  ["172.15.255.255", "just below 172.16/12"],
  ["172.32.0.1", "just above 172.16/12"],
  ["169.253.0.1", "just below link-local"],
  ["192.0.1.1", "between IETF assignments and TEST-NET-1"],
  ["198.17.255.255", "just below benchmarking"],
  ["198.20.0.1", "just above benchmarking"],
  ["223.255.255.255", "just below multicast"],
  ["2001:4860:4860::8888", "public IPv6"],
  ["2606:4700:4700::1111", "public IPv6"],
  ["2a00:1450:4001:81b::200e", "public IPv6"],
  ["2001:db9::1", "just above the documentation block"],
  ["::ffff:8.8.8.8", "IPv4-mapped public address"],
  ["::ffff:808:808", "IPv4-mapped public address, hex form"],
  ["2002:808:808::1", "6to4 of a public address"],
  ["0x08.8.8.8", "hexadecimal notation of a public address"],
  ["134744072", "decimal notation of a public address"],
];

describe("isPublicAddressText", () => {
  it.each(NON_PUBLIC)("refuses %s (%s)", (text) => {
    expect(isPublicAddressText(text)).toBe(false);
  });

  it.each(PUBLIC)("accepts %s (%s)", (text) => {
    expect(isPublicAddressText(text)).toBe(true);
  });
});

describe("parsing", () => {
  it("reads IPv4 in decimal, octal and hexadecimal notation", () => {
    expect(parseIPv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("0177.0.0.01")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("0x7f.0x1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("127.65535")).toEqual([127, 0, 255, 255]);
  });

  it("reads IPv6 with a compressed run and a dotted tail", () => {
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
    expect(parseIPv6("1::")).toEqual([0, 1, ...Array.from({ length: 14 }, () => 0)]);
  });

  it("formats an address the way a socket takes it", () => {
    expect(formatAddress({ family: 4, bytes: [127, 0, 0, 1] })).toBe("127.0.0.1");
    const parsed = parseAddress("2001:4860:4860::8888");
    expect(parsed?.family).toBe(6);
    expect(parsed === undefined ? "" : formatAddress(parsed)).toBe("2001:4860:4860:0:0:0:0:8888");
  });
});
