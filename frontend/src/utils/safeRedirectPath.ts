/**
 * Open-redirect hardening: only allow same-origin relative paths (e.g. `/`, `/bookmarks`).
 */
export function safeRedirectPath(redirectTo: string | null | undefined): string | null {
  if (redirectTo == null || redirectTo === '') return null;
  return redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : null;
}
