// The check of the page's requests that the smoke journey (e2e/tests/smoke.spec.ts) makes for the no-egress half of Q18: the shell asks
// for nothing outside the app's origin. A request is reported by its origin alone, never by its path or query.

/** The origins of the requests that are not to the app's origin; a `data:` or a `blob:` address is not a request to a network. */
export function foreignOrigins(requested: readonly string[], appOrigin: string): string[] {
  const origins = new Set<string>();
  for (const address of requested) {
    const url = new URL(address);
    if (["data:", "blob:", "about:"].includes(url.protocol)) {
      continue;
    }
    if (url.origin !== appOrigin) {
      origins.add(url.origin);
    }
  }
  return [...origins].sort();
}
