/**
 * Per-request CSP nonce for React Router v7 SSR (spec §18).
 *
 * Strategy: cryptographically random nonce passed to `ServerRouter`, `renderToReadableStream`,
 * and `<Scripts>` / `<ScrollRestoration>` / `<Links>` in `root.tsx` — see React Router security guide.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
