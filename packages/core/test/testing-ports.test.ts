import { FixedClock } from "@slugbase/testing-ports";
import { describe, expect, it } from "vitest";

describe("@slugbase/testing-ports from a core unit test", () => {
  it("imports an in-memory port fake without a package cycle", () => {
    const clock = new FixedClock(new Date("2030-06-15T12:00:00.000Z"));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2030-06-15T12:01:00.000Z");
  });
});
