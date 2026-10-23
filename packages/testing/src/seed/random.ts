/** A seeded source of numbers: the same seed yields the same sequence, so a seeded instance is the same on every run. */
export interface Random {
  /** The next number in [0, 1). */
  next(): number;
  /** A whole number in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** One of the items. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability. */
  chance(probability: number): boolean;
}

/** mulberry32: a 32-bit generator with a one-word state, enough for fixture data. */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) {
        throw new Error("pick needs a non-empty list");
      }
      return item;
    },
    chance: (probability) => next() < probability,
  };
}

/**
 * Identifiers in the shape of a UUIDv7 (Q91): a millisecond timestamp that rises with every call, then random bits from
 * the seeded source, so ids sort in creation order and are the same on every run.
 */
export function createIds(random: Random, startMs: number): () => string {
  let ms = startMs;
  return () => {
    ms += 1;
    const hex = (value: number, width: number): string => value.toString(16).padStart(width, "0");
    const time = hex(ms, 12);
    const randomA = hex(random.int(0x1000), 3);
    const variant = hex(0x8 + random.int(4), 1) + hex(random.int(0x1000), 3);
    const tail = hex(random.int(0x1000000), 6) + hex(random.int(0x1000000), 6);
    return `${time.slice(0, 8)}-${time.slice(8)}-7${randomA}-${variant}-${tail}`;
  };
}
