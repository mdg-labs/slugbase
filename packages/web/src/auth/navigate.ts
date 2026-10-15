/**
 * Leaves the app for an address with a top-level navigation. The OIDC start operations answer with a redirect
 * to the provider, which only the browser can follow, and the server accepts a link or re-authentication start
 * only from a request the browser reports as coming from the app itself (doc 04 section 4.5).
 */
export function navigateTo(address: string): void {
  globalThis.location.assign(address);
}
