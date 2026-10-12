import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/index.ts";

describe("FixedClock", () => {
  it("reports the instant it started at until it is moved", () => {
    const clock = new FixedClock(new Date("2030-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("advances and sets by explicit steps", () => {
    const clock = new FixedClock(1_000);
    clock.advance(500);
    expect(clock.now().getTime()).toBe(1_500);
    clock.set(new Date(9_000));
    expect(clock.now().getTime()).toBe(9_000);
  });

  it("hands out a new Date each call so a caller cannot move the clock", () => {
    const clock = new FixedClock(1_000);
    clock.now().setTime(0);
    expect(clock.now().getTime()).toBe(1_000);
  });
});
