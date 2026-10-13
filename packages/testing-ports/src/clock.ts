/**
 * A clock that only moves when a test moves it, so time-dependent behaviour is
 * deterministic (doc 08 section 3.1).
 */
export class FixedClock {
  #now: number;

  constructor(start: Date | number = 0) {
    this.#now = start instanceof Date ? start.getTime() : start;
  }

  now(): Date {
    return new Date(this.#now);
  }

  /** Moves the clock forward (or back, for a negative value) by `milliseconds`. */
  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }

  set(instant: Date | number): void {
    this.#now = instant instanceof Date ? instant.getTime() : instant;
  }
}
