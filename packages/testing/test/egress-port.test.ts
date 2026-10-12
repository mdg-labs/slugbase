import { EgressBlocked, EgressError, EgressTimeout, EgressTooLarge, type EgressPort } from "@slugbase/core";
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
});
