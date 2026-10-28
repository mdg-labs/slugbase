import { describe, expect, it } from "vitest";
import { FakeEgress, FakeEgressError } from "../src/index.ts";

const limits = { timeoutMs: 1_000, maxBytes: 100 };
const text = (body: Uint8Array): string => new TextDecoder().decode(body);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("FakeEgress", () => {
  it("answers a scripted URL and records the request", async () => {
    const egress = new FakeEgress({
      "https://example.test/a": { status: 201, contentType: "text/html", body: bytes("<p>hi</p>") },
    });
    const response = await egress.request({ url: "https://example.test/a", ...limits });
    expect(response).toMatchObject({ url: "https://example.test/a", status: 201, contentType: "text/html" });
    expect(text(response.body)).toBe("<p>hi</p>");
    expect(egress.available).toBe(true);
    expect(egress.requests.map((request) => request.url)).toEqual(["https://example.test/a"]);
  });

  it("defaults to a 200 with an empty body", async () => {
    const egress = new FakeEgress({ "https://example.test/": {} });
    expect(await egress.request({ url: "https://example.test/", ...limits })).toMatchObject({ status: 200, contentType: undefined });
  });

  it("fails loudly for a URL with no route", async () => {
    await expect(new FakeEgress().request({ url: "https://nowhere.test/", ...limits })).rejects.toThrow("no route");
  });

  it("follows a redirect and answers from its target", async () => {
    const egress = new FakeEgress({
      "https://example.test/old": { kind: "redirect", to: "https://other.test/new" },
      "https://other.test/new": { body: bytes("moved"), contentType: "text/plain" },
    });
    const response = await egress.request({ url: "https://example.test/old", ...limits });
    expect(response).toMatchObject({ url: "https://other.test/new", status: 200, contentType: "text/plain" });
    expect(text(response.body)).toBe("moved");
    expect(egress.requests.map((request) => request.url)).toEqual(["https://example.test/old"]);
    expect(egress.fetched).toEqual(["https://example.test/old", "https://other.test/new"]);
  });

  it("resolves a relative redirect against the URL that answered", async () => {
    const egress = new FakeEgress({
      "https://example.test/a/b": { kind: "redirect", to: "c" },
      "https://example.test/a/c": { kind: "redirect", to: "/d?x=1" },
      "https://example.test/d?x=1": { kind: "redirect", to: "//cdn.test/e" },
      "https://cdn.test/e": { body: bytes("done") },
    });
    const response = await egress.request({ url: "https://example.test/a/b", ...limits });
    expect(response.url).toBe("https://cdn.test/e");
    expect(egress.fetched).toHaveLength(4);
  });

  it("refuses a redirect to a private address without looking it up", async () => {
    const egress = new FakeEgress({
      "https://evil.test/favicon.ico": { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" },
      "http://169.254.169.254/latest/meta-data/": { body: bytes("secret") },
    });
    await expect(egress.request({ url: "https://evil.test/favicon.ico", ...limits })).rejects.toMatchObject({
      code: "egress_blocked",
      name: "EgressBlocked",
    });
    expect(egress.fetched).toEqual(["https://evil.test/favicon.ico"]);
  });

  it.each([
    ["the loopback address", "http://127.0.0.1/"],
    ["a loopback address in decimal notation", "http://2130706433/"],
    ["a private address", "http://10.1.2.3/"],
    ["a CGNAT address", "http://100.64.0.1/"],
    ["the IPv6 loopback address", "http://[::1]/"],
    ["an IPv4-mapped loopback address", "http://[::ffff:127.0.0.1]/"],
    ["a unique-local address", "http://[fd00::1]/"],
    ["a documentation address", "http://[2001:db8::1]/"],
    ["a 6to4 address embedding a private one", "http://[2002:a00:1::]/"],
  ])("refuses a request and a redirect to %s", async (_name, target) => {
    const egress = new FakeEgress({ [target]: {}, "https://evil.test/": { kind: "redirect", to: target } });
    await expect(egress.request({ url: target, ...limits })).rejects.toMatchObject({ code: "egress_blocked" });
    await expect(egress.request({ url: "https://evil.test/", ...limits })).rejects.toMatchObject({ code: "egress_blocked" });
    expect(egress.fetched).toEqual(["https://evil.test/"]);
  });

  it.each(["8.8.8.8", "[2606:4700:4700::1111]", "[2002:808:808::]", "[::ffff:8.8.8.8]"])("accepts the public address %s", async (host) => {
    const egress = new FakeEgress({ [`http://${host}/`]: { body: bytes("ok") } });
    expect(text((await egress.request({ url: `http://${host}/`, ...limits })).body)).toBe("ok");
  });

  it.each([
    "ftp://example.test/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:secret@example.test/",
    "http://",
  ])("refuses a redirect to %j", async (target) => {
    const egress = new FakeEgress({ "https://evil.test/": { kind: "redirect", to: target } });
    await expect(egress.request({ url: "https://evil.test/", ...limits })).rejects.toMatchObject({ code: "egress_blocked" });
  });

  it("refuses a first URL the port refuses", async () => {
    const egress = new FakeEgress({ "ftp://example.test/file": {} });
    await expect(egress.request({ url: "ftp://example.test/file", ...limits })).rejects.toMatchObject({ code: "egress_blocked" });
  });

  it("refuses a redirect loop, including one back to the first URL and one that differs only by fragment", async () => {
    const egress = new FakeEgress({
      "https://example.test/a": { kind: "redirect", to: "https://example.test/b" },
      "https://example.test/b": { kind: "redirect", to: "https://example.test/a#again" },
      "https://example.test/self": { kind: "redirect", to: "/self" },
    });
    await expect(egress.request({ url: "https://example.test/a", ...limits })).rejects.toMatchObject({ code: "egress_failed" });
    await expect(egress.request({ url: "https://example.test/self", ...limits })).rejects.toMatchObject({ code: "egress_failed" });
  });

  it("follows five redirects and refuses a sixth", async () => {
    const chain = (length: number): FakeEgress => {
      const egress = new FakeEgress({ [`https://example.test/${String(length)}`]: { body: bytes("end") } });
      for (let index = 0; index < length; index += 1) {
        egress.script(`https://example.test/${String(index)}`, { kind: "redirect", to: `/${String(index + 1)}` });
      }
      return egress;
    };
    expect((await chain(5).request({ url: "https://example.test/0", ...limits })).url).toBe("https://example.test/5");
    await expect(chain(6).request({ url: "https://example.test/0", ...limits })).rejects.toMatchObject({ code: "egress_failed" });
  });

  it("applies the content-type allowlist to the final response, ignoring parameters and case", async () => {
    const egress = new FakeEgress({
      "https://example.test/redirect": { kind: "redirect", to: "/icon" },
      "https://example.test/icon": { contentType: "Image/PNG; charset=binary", body: bytes("png") },
      "https://example.test/page": { contentType: "text/html", body: bytes("<p>") },
      "https://example.test/untyped": { body: bytes("?") },
    });
    const accept = { acceptContentTypes: ["image/png", "image/x-icon"] };
    expect((await egress.request({ url: "https://example.test/redirect", ...limits, ...accept })).status).toBe(200);
    await expect(egress.request({ url: "https://example.test/page", ...limits, ...accept })).rejects.toMatchObject({ code: "egress_failed" });
    await expect(egress.request({ url: "https://example.test/untyped", ...limits, ...accept })).rejects.toMatchObject({ code: "egress_failed" });
    await expect(egress.request({ url: "https://example.test/page", ...limits, acceptContentTypes: [] })).rejects.toMatchObject({
      code: "egress_failed",
    });
    expect((await egress.request({ url: "https://example.test/page", ...limits })).status).toBe(200);
  });

  it("checks the content type before the size", async () => {
    const egress = new FakeEgress({ "https://example.test/": { contentType: "text/html", body: new Uint8Array(1_000) } });
    await expect(egress.request({ url: "https://example.test/", ...limits, acceptContentTypes: ["image/png"] })).rejects.toMatchObject({
      code: "egress_failed",
    });
  });

  it("refuses a destination scripted as blocked", async () => {
    const egress = new FakeEgress({ "http://169.254.169.254/latest/meta-data/": { kind: "blocked" } });
    const error: unknown = await egress.request({ url: "http://169.254.169.254/latest/meta-data/", ...limits }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FakeEgressError);
    expect(error).toMatchObject({ code: "egress_blocked", name: "EgressBlocked" });
  });

  it("refuses a POST body over 1 MiB, and accepts one at it", async () => {
    const egress = new FakeEgress({ "https://example.test/": {} });
    await expect(
      egress.request({ url: "https://example.test/", method: "POST", body: new Uint8Array(1_048_577), ...limits }),
    ).rejects.toMatchObject({ code: "egress_too_large" });
    const response = await egress.request({ url: "https://example.test/", method: "POST", body: new Uint8Array(1_048_576), ...limits });
    expect(response.status).toBe(200);
  });

  it("refuses a body over the cap before it looks up the route", async () => {
    await expect(
      new FakeEgress().request({ url: "https://nowhere.test/", method: "POST", body: new Uint8Array(1_048_577), ...limits }),
    ).rejects.toMatchObject({ code: "egress_too_large" });
  });

  it.each([
    ["a zero time budget", { timeoutMs: 0, maxBytes: 10 }],
    ["a negative time budget", { timeoutMs: -1, maxBytes: 10 }],
    ["a NaN time budget", { timeoutMs: Number.NaN, maxBytes: 10 }],
    ["an infinite time budget", { timeoutMs: Number.POSITIVE_INFINITY, maxBytes: 10 }],
    ["a fractional maximum", { timeoutMs: 1_000, maxBytes: 1.5 }],
    ["a negative maximum", { timeoutMs: 1_000, maxBytes: -1 }],
  ])("throws a RangeError for %s", async (_name, invalid) => {
    const egress = new FakeEgress({ "https://example.test/": {} });
    await expect(egress.request({ url: "https://example.test/", ...invalid })).rejects.toBeInstanceOf(RangeError);
  });

  it("throws a RangeError for a POST without a body", async () => {
    const egress = new FakeEgress({ "https://example.test/": {} });
    await expect(egress.request({ url: "https://example.test/", method: "POST", ...limits })).rejects.toBeInstanceOf(RangeError);
  });

  it("refuses a body over the request's maximum, and accepts one at it", async () => {
    const egress = new FakeEgress({ "https://big.test/": { body: new Uint8Array(101) }, "https://edge.test/": { body: new Uint8Array(100) } });
    await expect(egress.request({ url: "https://big.test/", ...limits })).rejects.toMatchObject({ code: "egress_too_large" });
    expect((await egress.request({ url: "https://edge.test/", ...limits })).body).toHaveLength(100);
  });

  it("cuts a body over the maximum to the maximum when the request asks to truncate, and still refuses a type outside the list", async () => {
    const body = Uint8Array.from({ length: 101 }, (_, index) => index);
    const egress = new FakeEgress({ "https://big.test/": { body, contentType: "text/html" } });
    const response = await egress.request({ url: "https://big.test/", truncateAtMaxBytes: true, ...limits });
    expect(response.body).toEqual(body.subarray(0, 100));
    await expect(egress.request({ url: "https://big.test/", truncateAtMaxBytes: true, acceptContentTypes: ["image/png"], ...limits })).rejects.toMatchObject({
      code: "egress_failed",
    });
  });

  it("answers HEAD without a body", async () => {
    const egress = new FakeEgress({ "https://big.test/": { body: new Uint8Array(1_000), contentType: "image/png" } });
    const response = await egress.request({ url: "https://big.test/", method: "HEAD", ...limits });
    expect(response).toMatchObject({ contentType: "image/png" });
    expect(response.body).toHaveLength(0);
  });

  it("times out when scripted to", async () => {
    const egress = new FakeEgress().script("https://slow.test/", { kind: "timeout" });
    await expect(egress.request({ url: "https://slow.test/", ...limits })).rejects.toMatchObject({ code: "egress_timeout" });
  });
});
