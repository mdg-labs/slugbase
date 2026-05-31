import { describe, expect, it } from "vitest";

import {
  assertPublicHost,
  isBlockedHostname,
  isPrivateOrLoopbackAddress,
  parseAndValidateRequestUrl,
} from "./host-validation.js";

describe("isPrivateOrLoopbackAddress", () => {
  it("blocks loopback IPv4", () => {
    expect(isPrivateOrLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackAddress("127.255.255.254")).toBe(true);
  });

  it("blocks RFC1918 IPv4 ranges", () => {
    expect(isPrivateOrLoopbackAddress("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackAddress("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackAddress("192.168.1.10")).toBe(true);
  });

  it("blocks link-local IPv4", () => {
    expect(isPrivateOrLoopbackAddress("169.254.169.254")).toBe(true);
  });

  it("allows public IPv4", () => {
    expect(isPrivateOrLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackAddress("1.1.1.1")).toBe(false);
  });

  it("blocks loopback and link-local IPv6", () => {
    expect(isPrivateOrLoopbackAddress("::1")).toBe(true);
    expect(isPrivateOrLoopbackAddress("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackAddress("fc00::1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isPrivateOrLoopbackAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks localhost and metadata hostnames", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("app.localhost")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });

  it("blocks literal private IPs in hostname", () => {
    expect(isBlockedHostname("192.168.0.1")).toBe(true);
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
  });
});

describe("assertPublicHost", () => {
  it("rejects hosts that resolve to private addresses", async () => {
    await expect(
      assertPublicHost("internal.example", () =>
        Promise.resolve([{ address: "10.0.0.5", family: 4 }]),
      ),
    ).rejects.toThrow(/Resolved address is not public/);
  });

  it("accepts hosts that resolve to public addresses", async () => {
    await expect(
      assertPublicHost("example.com", () =>
        Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("parseAndValidateRequestUrl", () => {
  it("accepts http and https URLs", () => {
    expect(parseAndValidateRequestUrl("https://example.com/path").hostname).toBe(
      "example.com",
    );
  });

  it("rejects unsupported protocols", () => {
    expect(() => parseAndValidateRequestUrl("file:///etc/passwd")).toThrow(
      /Unsupported protocol/,
    );
  });
});
