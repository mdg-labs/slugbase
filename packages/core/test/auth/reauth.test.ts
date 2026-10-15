import { FixedClock } from "@slugbase/testing-ports";
import { describe, expect, it } from "vitest";
import { REAUTH_WINDOW_MS, reauthenticatedRecently } from "../../src/auth/reauth.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-10-14T12:00:00.000Z");

describe("reauthenticatedRecently", () => {
  it("is ten minutes", () => {
    expect(REAUTH_WINDOW_MS).toBe(10 * MINUTE);
  });

  it("accepts a re-authentication 9 minutes old and refuses one 11 minutes old, by the clock it is given", () => {
    const clock = new FixedClock(START);
    const reauthAt = clock.now();
    clock.advance(9 * MINUTE);
    expect(reauthenticatedRecently(reauthAt, clock.now().getTime())).toBe(true);
    clock.advance(2 * MINUTE);
    expect(reauthenticatedRecently(reauthAt, clock.now().getTime())).toBe(false);
  });

  it("accepts the exact end of the window and refuses a millisecond past it", () => {
    const reauthAt = new Date(START);
    expect(reauthenticatedRecently(reauthAt, START + REAUTH_WINDOW_MS)).toBe(true);
    expect(reauthenticatedRecently(reauthAt, START + REAUTH_WINDOW_MS + 1)).toBe(false);
  });

  it("refuses a missing, invalid or future timestamp", () => {
    expect(reauthenticatedRecently(undefined, START)).toBe(false);
    expect(reauthenticatedRecently(new Date(Number.NaN), START)).toBe(false);
    expect(reauthenticatedRecently(new Date(START + MINUTE), START)).toBe(false);
  });

  it("accepts a stamp up to 5 seconds ahead of the clock it is given and refuses one a millisecond further", () => {
    expect(reauthenticatedRecently(new Date(START + 5_000), START)).toBe(true);
    expect(reauthenticatedRecently(new Date(START + 5_000 + 1), START)).toBe(false);
  });

  it("keeps the end of the window exact where the stamp is ahead of the clock", () => {
    expect(reauthenticatedRecently(new Date(START), START + REAUTH_WINDOW_MS)).toBe(true);
    expect(reauthenticatedRecently(new Date(START), START + REAUTH_WINDOW_MS + 1)).toBe(false);
    expect(reauthenticatedRecently(new Date(START - 5_000), START + REAUTH_WINDOW_MS - 5_000)).toBe(true);
    expect(reauthenticatedRecently(new Date(START - 5_000), START + REAUTH_WINDOW_MS - 5_000 + 1)).toBe(false);
  });
});
