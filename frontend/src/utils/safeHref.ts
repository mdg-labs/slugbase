/**
 * Return a safe href for <a> tags (http/https only). Use for bookmark and preference URLs
 * as defense-in-depth; backend already validates on save.
 * Returns '#' for invalid or dangerous schemes (e.g. javascript:, data:) so the link does nothing.
 */
export function safeHref(url: string | undefined | null): string {
  if (!url || typeof url !== 'string') {
    return '#';
  }
  const trimmed = url.trim();
  if (!trimmed) return '#';
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:') ||
    lower.startsWith('about:')
  ) {
    return '#';
  }
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    // invalid URL
  }
  return '#';
}
