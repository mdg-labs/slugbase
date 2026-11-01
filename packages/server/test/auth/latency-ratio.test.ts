import { afterEach, describe, expect, it, vi } from "vitest";
import { fastLatencyRatios, latencyCalls, medianLatencyRatio } from "./support.ts";

// `medianLatencyRatio` and `fastLatencyRatios` on a clock the sides advance themselves, so the ratios are exact and no host load enters.

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

/**
 * A side whose call takes `cost` of the virtual clock plus `extra(n)` on its n-th measured call (0-based, after the
 * unmeasured warm-up call), the work a mutation of the code under test would add to some of the calls.
 */
function workingSide(cost: number, extra: (measured: number) => number): () => Promise<void> {
  let calls = 0;
  return () => {
    const measured = calls - 1;
    calls += 1;
    now += cost + (measured >= 0 ? extra(measured) : 0);
    return Promise.resolve();
  };
}

describe("fastLatencyRatios", () => {
  const ROUNDS = 30;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withVirtualClock(): void {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  }

  it("reads 1 on both readings for two sides of one cost, and the cost ratio for sides that differ", async () => {
    withVirtualClock();
    const equal = await fastLatencyRatios(workingSide(10, () => 0), workingSide(10, () => 0), ROUNDS);
    expect(equal.fastest).toBeCloseTo(1, 10);
    expect(equal.quartile).toBeCloseTo(1, 10);
    const cheaper = await fastLatencyRatios(workingSide(10, () => 0), workingSide(4, () => 0), ROUNDS);
    expect(cheaper.fastest).toBeCloseTo(0.4, 10);
    expect(cheaper.quartile).toBeCloseTo(0.4, 10);
  });

  it("reads work on every call of a side on both readings", async () => {
    withVirtualClock();
    const ratios = await fastLatencyRatios(workingSide(10, () => 0), workingSide(10, () => 3), ROUNDS);
    expect(ratios.fastest).toBeCloseTo(1.3, 10);
    expect(ratios.quartile).toBeCloseTo(1.3, 10);
  });

  it("reads work on four calls in five on the quartile and not on the fastest call", async () => {
    withVirtualClock();
    const ratios = await fastLatencyRatios(workingSide(10, () => 0), workingSide(10, (measured) => (measured % 5 === 0 ? 0 : 30)), ROUNDS);
    expect(ratios.fastest).toBeCloseTo(1, 10);
    expect(ratios.quartile).toBeCloseTo(4, 10);
  });

  it("does not read work that more than a quarter of the calls of a side skip", async () => {
    withVirtualClock();
    // Three calls in five do the work: the first quartile of the side is still a call that did not.
    const ratios = await fastLatencyRatios(workingSide(10, () => 0), workingSide(10, (measured) => (measured % 5 < 3 ? 30 : 0)), ROUNDS);
    expect(ratios.fastest).toBeCloseTo(1, 10);
    expect(ratios.quartile).toBeCloseTo(1, 10);
  });

  it("reads delay on a fifth of the calls of a side on neither reading", async () => {
    withVirtualClock();
    const ratios = await fastLatencyRatios(workingSide(10, () => 0), workingSide(10, (measured) => (measured % 5 === 0 ? 40 : 0)), ROUNDS);
    expect(ratios.fastest).toBeCloseTo(1, 10);
    expect(ratios.quartile).toBeCloseTo(1, 10);
  });

  it("reads a side that skips its work as far below the lower bound of the latency tests on both readings", async () => {
    withVirtualClock();
    const ratios = await fastLatencyRatios(workingSide(8, () => 0), workingSide(1, () => 0), ROUNDS);
    expect(ratios.fastest).toBeLessThan(0.5);
    expect(ratios.quartile).toBeLessThan(0.5);
  });

  it("is not moved by a call being slower for following another one, whichever side it is", async () => {
    withVirtualClock();
    // Equal sides, and the second of every pair takes 6 more; both sides are followers as often as leaders.
    const position = { calls: 0 };
    const ratios = await fastLatencyRatios(side(10, 6, position), side(10, 6, position), ROUNDS);
    expect(ratios.fastest).toBeCloseTo(1, 10);
    expect(ratios.quartile).toBeCloseTo(1, 10);
  });

  it("calls each side once to warm up and once per round of either order", async () => {
    withVirtualClock();
    let reference = 0;
    let probe = 0;
    await fastLatencyRatios(() => Promise.resolve(void (reference += 1)), () => Promise.resolve(void (probe += 1)), ROUNDS);
    expect(reference).toBe(latencyCalls(ROUNDS));
    expect(probe).toBe(latencyCalls(ROUNDS));
  });
});
