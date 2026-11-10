import { describe, expect, it } from "vitest";
import {
  EgressBlocked,
  EgressBusy,
  EgressError,
  EgressTimeout,
  EgressTooLarge,
  PortUnavailable,
  unconfigured,
} from "../../src/index.ts";

describe("the egress errors", () => {
  it.each([
    [new EgressBlocked(), "egress_blocked", "EgressBlocked"],
    [new EgressTimeout(), "egress_timeout", "EgressTimeout"],
    [new EgressTooLarge(), "egress_too_large", "EgressTooLarge"],
    [new EgressBusy(), "egress_busy", "EgressBusy"],
    [new EgressError(), "egress_failed", "EgressError"],
  ])("%s is an EgressError with a fixed code and no cause", (error, code, name) => {
    expect(error).toBeInstanceOf(EgressError);
    expect(error.code).toBe(code);
    expect(error.name).toBe(name);
    expect(error.cause).toBeUndefined();
  });

  it("gives a busy refusal a fixed message that names no network detail", () => {
    expect(new EgressBusy().message).toBe("The request could not be started now");
  });
});

describe("the unconfigured egress port", () => {
  it("rejects a request with PortUnavailable", async () => {
    const port = unconfigured().egress;
    expect(port.available).toBe(false);
    await expect(port.request({ url: "https://example.test/", timeoutMs: 1_000, maxBytes: 10 })).rejects.toBeInstanceOf(
      PortUnavailable,
    );
  });
});
