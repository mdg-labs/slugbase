import { describe, expect, it } from "vitest";
import { ascendingUuidv7, uuidv7 } from "../../src/auth/uuidv7.ts";

describe("uuidv7", () => {
  it("is a version 7, RFC 9562 variant UUID", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("starts with the Unix time in milliseconds", () => {
    const at = Date.UTC(2026, 9, 14, 12, 0, 0);
    const id = uuidv7(at);
    expect(Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16)).toBe(at);
  });

  it("sorts by time and is unique", () => {
    const earlier = uuidv7(1_000_000_000_000);
    const later = uuidv7(1_000_000_000_001);
    expect(earlier < later).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => uuidv7())).size).toBe(200);
  });
});

describe("ascendingUuidv7", () => {
  const millisecondOf = (id: string) => Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);

  it("ascends with every call, also when the clock stands still or steps back", () => {
    const readings = [5_000, 5_000, 5_000, 4_000, 5_001, 9_000];
    const next = ascendingUuidv7(() => readings.shift() ?? 0);

    const milliseconds = Array.from({ length: 6 }, () => millisecondOf(next()));

    expect(milliseconds).toEqual([5_000, 5_001, 5_002, 5_003, 5_004, 9_000]);
  });

  it("lists the identifiers in the order they were made when they are sorted as text and as bytes", () => {
    const next = ascendingUuidv7(() => 1_000_000_000_000);
    const ids = Array.from({ length: 5000 }, () => next());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
