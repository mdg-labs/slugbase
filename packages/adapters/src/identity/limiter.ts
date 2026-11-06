/** Runs a task once a slot is free; resolves or rejects as the task does. */
export type Limited = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A first-in, first-out limiter: at most `max` tasks run at once and the rest wait in the order they asked. A
 * finished task hands its slot straight to the next waiter, so the slot is released whether the task resolved,
 * rejected or threw before it returned a promise, and a waiter is never overtaken by a later arrival.
 */
export function createFifoLimiter(max: number): Limited {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < max) {
      running += 1;
    } else {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) {
        running -= 1;
      } else {
        next();
      }
    }
  };
}
