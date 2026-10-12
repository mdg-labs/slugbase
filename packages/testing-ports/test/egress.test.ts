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

  it("returns a redirect as its 3xx response without following it", async () => {
    const egress = new FakeEgress({
      "https://example.test/old": { kind: "redirect", to: "https://example.test/new" },
      "https://example.test/new": { body: bytes("moved") },
    });
    const response = await egress.request({ url: "https://example.test/old", ...limits });
    expect(response).toMatchObject({ url: "https://example.test/old", status: 302, contentType: undefined });
    expect(response.body).toHaveLength(0);
    expect(egress.requests.map((request) => request.url)).toEqual(["https://example.test/old"]);
    const permanent = new FakeEgress({ "https://example.test/": { kind: "redirect", to: "https://example.test/x", status: 308 } });
    expect((await permanent.request({ url: "https://example.test/", ...limits })).status).toBe(308);
  });

  it("answers a redirect to a private address as a response, leaving the hop to the caller", async () => {
    const egress = new FakeEgress({
      "https://evil.test/favicon.ico": { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" },
    });
    const response = await egress.request({ url: "https://evil.test/favicon.ico", ...limits });
    expect(response.status).toBe(302);
    expect(egress.requests).toHaveLength(1);
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
