/** Lets the event loop run its other work (the requests of other members) before the caller goes on. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
