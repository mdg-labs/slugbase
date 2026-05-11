/**
 * Favicon URL for bookmark tiles — uses same-origin API proxy (SSRF-safe server fetch, strict CSP friendly).
 */
export async function fetchFavicon(url: string): Promise<string> {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    return '';
  }
  try {
    // Validate URL shape client-side (server re-validates).
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    return '';
  }
  const params = new URLSearchParams({ site: trimmed });
  return `/api/bookmarks/favicon?${params.toString()}`;
}
