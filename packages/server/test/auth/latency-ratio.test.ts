import { afterEach, describe, expect, it, vi } from "vitest";
import { latencyCalls, medianLatencyRatio } from "./support.ts";

// `medianLatencyRatio` on a clock the sides advance themselves, so the ratios are exact and no host load enters.

let now = 0;

/** A side that takes `cost` of the virtual clock, plus `followerPenalty` when it is the second call of a pair. */
function side(cost: number, followerPenalty: number, position: { calls: number }): () => Promise<void> {
  return () => {
    // The first two calls are the unmeasured warm-up; every pair after it is a leader and a follower.
    const follower = position.calls >= 2 && position.calls % 2 === 1;
    position.calls += 1;
    now += cost + (follower ? followerPenalty : 0);
    return Promise.resolve();
  };
}

describe("medianLatencyRatio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withVirtualClock(): void {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  }

  it("reads 1 for two sides of one cost, and the cost ratio for sides that differ", async () => {
    withVirtualClock();
    const position = { calls: 0 };
    expect(await medianLatencyRatio(side(10, 0, position), side(10, 0, position))).toBeCloseTo(1, 10);
    expect(await medianLatencyRatio(side(10, 0, position), side(4, 0, position))).toBeCloseTo(0.4, 10);
  });

  it("reads a side that skips its work as far below the lower bound of the sign-in latency tests", async () => {
    withVirtualClock();
    const position = { calls: 0 };
    expect(await medianLatencyRatio(side(8, 0, position), side(1, 0, position))).toBeLessThan(0.5);
  });

  it("is not moved by a call being slower for following another one, whichever side it is", async () => {
    withVirtualClock();
    const position = { calls: 0 };
    // Equal sides, and the second of every pair takes 6 more: the order in which a pair is timed must not show in the ratio.
    expect(await medianLatencyRatio(side(10, 6, position), side(10, 6, position))).toBeCloseTo(1, 10);
  });

  it("calls each side once to warm up and once per round of either order", async () => {
    withVirtualClock();
    let reference = 0;
    let probe = 0;
    await medianLatencyRatio(() => Promise.resolve(void (reference += 1)), () => Promise.resolve(void (probe += 1)));
    expect(reference).toBe(latencyCalls());
    expect(probe).toBe(latencyCalls());
  });
});
