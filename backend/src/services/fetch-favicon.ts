/**
 * SSRF-safe favicon fetch (default /favicon.ico) for same-origin img URLs under strict CSP.
 */

import { resolveAndCheckHost } from './fetch-page-metadata.js';

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; SlugBase/1.0; +https://slugbase.app)';

function allowedImageContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return (
    lower.includes('image/x-icon') ||
    lower.includes('image/vnd.microsoft.icon') ||
    lower.startsWith('image/png') ||
    lower.startsWith('image/jpeg') ||
    lower.startsWith('image/jpg') ||
    lower.startsWith('image/gif') ||
    lower.startsWith('image/webp') ||
    lower.startsWith('image/svg') ||
    lower.startsWith('application/octet-stream')
  );
}

export interface FaviconFetchResult {
  body: Buffer;
  contentType: string;
}

/**
 * @param siteUrl - Full bookmark URL or origin; uses that host's `/favicon.ico` over https or http.
 */
export async function fetchFaviconForSite(siteUrl: string): Promise<FaviconFetchResult | null> {
  if (!siteUrl || typeof siteUrl !== 'string') return null;
  const trimmed = siteUrl.trim();
  if (!trimmed) return null;

  let base: URL;
  try {
    base = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = base.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  const hostname = base.hostname;
  if (!hostname) return null;

  try {
    await resolveAndCheckHost(hostname);
  } catch {
    return null;
  }

  const faviconUrl = `${base.origin}/favicon.ico`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = faviconUrl;
    let redirectCount = 0;

    while (redirectCount <= MAX_REDIRECTS) {
      const res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || redirectCount >= MAX_REDIRECTS) return null;
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return null;
        await resolveAndCheckHost(nextUrl.hostname);
        currentUrl = nextUrl.toString();
        redirectCount++;
        continue;
      }

      if (!res.ok) return null;

      const contentType = (res.headers.get('content-type') || '').split(';')[0]?.trim() || 'application/octet-stream';
      if (!allowedImageContentType(contentType)) return null;

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) return null;

      return { body: buf, contentType };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
