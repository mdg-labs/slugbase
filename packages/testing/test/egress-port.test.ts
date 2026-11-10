import { EgressBlocked, EgressBusy, EgressError, EgressTimeout, EgressTooLarge, type EgressPort } from "@slugbase/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { FakeEgress, FakeEgressError } from "../src/index.ts";

// Doc 08 section 3.1: the in-memory ports are checked against the ports they stand in for here, in
// @slugbase/testing, because @slugbase/testing-ports imports no workspace package.
describe("FakeEgress against EgressPort", () => {
  it("is assignable to the port, so a change to the port that the fake does not follow fails the typecheck", () => {
    expectTypeOf<FakeEgress>().toExtend<EgressPort>();
    const port: EgressPort = new FakeEgress();
    expect(port.available).toBe(true);
  });

  it("throws errors that carry the code, name and message of the port's errors", () => {
    const pairs = [
      ["egress_blocked", new EgressBlocked()],
      ["egress_timeout", new EgressTimeout()],
      ["egress_too_large", new EgressTooLarge()],
      ["egress_busy", new EgressBusy()],
      ["egress_failed", new EgressError()],
    ] as const;
    for (const [code, real] of pairs) {
      const fake = new FakeEgressError(code);
      expect(fake.code).toBe(real.code);
      expect(fake.name).toBe(real.name);
      expect(fake.message).toBe(real.message);
    }
  });

  it("answers a request through the port type", async () => {
    const port: EgressPort = new FakeEgress({ "https://example.test/": { status: 204 } });
    await expect(port.request({ url: "https://example.test/", timeoutMs: 1_000, maxBytes: 10 })).resolves.toMatchObject({ status: 204 });
  });

  it("takes the truncate flag of the port's request and cuts the body as the port does", async () => {
    const port: EgressPort = new FakeEgress({ "https://example.test/": { body: new Uint8Array(20) } });
    const cut = await port.request({ url: "https://example.test/", timeoutMs: 1_000, maxBytes: 10, truncateAtMaxBytes: true });
    expect(cut.body).toHaveLength(10);
    await expect(port.request({ url: "https://example.test/", timeoutMs: 1_000, maxBytes: 10 })).rejects.toMatchObject({ code: new EgressTooLarge().code });
  });

  it("follows redirects and refuses the ones the port refuses, as errors of the port's classes", async () => {
    const port: EgressPort = new FakeEgress({
      "https://example.test/old": { kind: "redirect", to: "/new" },
      "https://example.test/new": { contentType: "image/png" },
      "https://example.test/loop": { kind: "redirect", to: "/loop" },
      "https://evil.test/": { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" },
    });
    const limits = { timeoutMs: 1_000, maxBytes: 10 };
    await expect(port.request({ url: "https://example.test/old", acceptContentTypes: ["image/png"], ...limits })).resolves.toMatchObject({
      url: "https://example.test/new",
    });
    const rejected = (url: string, extra: { acceptContentTypes?: readonly string[] } = {}): Promise<unknown> =>
      port.request({ url, ...extra, ...limits }).then(
        () => undefined,
        (error: unknown) => error,
      );
    const plain = new EgressError();
    const blocked = new EgressBlocked();
    expect(await rejected("https://evil.test/")).toMatchObject({ code: blocked.code, name: blocked.name, message: blocked.message });
    expect(await rejected("https://example.test/loop")).toMatchObject({ code: plain.code, name: plain.name, message: plain.message });
    expect(await rejected("https://example.test/new", { acceptContentTypes: ["text/html"] })).toMatchObject({ code: plain.code });
  });

  it("refuses an https to http redirect when the request sets refuseHttpDowngrade, as the port does, and follows the other hops", async () => {
    const port: EgressPort = new FakeEgress({
      "https://idp.example.test/keys": { kind: "redirect", to: "http://idp.example.test/keys" },
      "http://idp.example.test/keys": {},
      "https://idp.example.test/moved": { kind: "redirect", to: "https://other.example.test/keys" },
      "https://other.example.test/keys": {},
      "http://plain.example.test/a": { kind: "redirect", to: "http://plain.example.test/b" },
      "http://plain.example.test/b": {},
    });
    const guarded = { refuseHttpDowngrade: true, timeoutMs: 1_000, maxBytes: 10 };
    await expect(port.request({ url: "https://idp.example.test/keys", ...guarded })).rejects.toMatchObject({ code: new EgressBlocked().code });
    await expect(port.request({ url: "https://idp.example.test/moved", ...guarded })).resolves.toMatchObject({ url: "https://other.example.test/keys" });
    await expect(port.request({ url: "http://plain.example.test/a", ...guarded })).resolves.toMatchObject({ url: "http://plain.example.test/b" });
    await expect(port.request({ url: "https://idp.example.test/keys", timeoutMs: 1_000, maxBytes: 10 })).resolves.toMatchObject({
      url: "http://idp.example.test/keys",
    });
  });
});
