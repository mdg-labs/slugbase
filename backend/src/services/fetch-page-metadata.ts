/**
 * SSRF-safe page metadata fetcher for AI bookmark suggestions.
 * Fetches URL, extracts <title> and <meta> tags, blocks private/internal IPs.
 */

import dns from 'dns';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 100 * 1024; // 100 KB
const MAX_REDIRECTS = 3;
const USER_AGENT = 'SlugBase/1.0 (bookmark metadata)';

/** Private/internal IP ranges - SSRF protection */
const PRIVATE_IPV4_RANGES = [
  { start: 0x7f000000, end: 0x7fffffff },   // 127.0.0.0/8
  { start: 0x0a000000, end: 0x0affffff },   // 10.0.0.0/8
  { start: 0xac100000, end: 0xac1fffff },   // 172.16.0.0/12
  { start: 0xc0a80000, end: 0xc0a8ffff },   // 192.168.0.0/16
  { start: 0xa9fe0000, end: 0xa9feffff },   // 169.254.0.0/16 (link-local)
  { start: 0xe0000000, end: 0xefffffff },   // 224.0.0.0/4 (multicast)
];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true;
  const num = (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
  return PRIVATE_IPV4_RANGES.some((r) => num >= r.start && num <= r.end);
}

function isPrivateIPv6(ip: string): boolean {
  if (ip === '::1') return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

async function resolveAndCheckHost(hostname: string): Promise<void> {
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);
    const ips: string[] = [];
    if (ipv4.status === 'fulfilled') ips.push(...ipv4.value);
    if (ipv6.status === 'fulfilled') ips.push(...ipv6.value);
    for (const ip of ips) {
      if (ip.includes('.')) {
        if (isPrivateIPv4(ip)) throw new Error('Private or internal IP not allowed');
      } else {
        if (isPrivateIPv6(ip)) throw new Error('Private or internal IP not allowed');
      }
    }
    if (ips.length === 0) throw new Error('Could not resolve hostname');
  } catch (e: any) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') throw new Error('Could not resolve hostname');
    throw e;
  }
}

export interface PageMetadata {
  title?: string;
  description?: string;
}

/**
 * Extract title and description from HTML string.
 * Looks for <title>, <meta name="description">, og:title, og:description.
 */
function extractMetadataFromHtml(html: string): PageMetadata {
  const result: PageMetadata = {};

  // <title>...</title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    result.title = titleMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  // <meta name="description" content="...">
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  if (descMatch?.[1]) {
    result.description = descMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
  }

  // og:title, og:description (fallback)
  if (!result.title) {
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
    if (ogTitle?.[1]) {
      result.title = ogTitle[1].replace(/\s+/g, ' ').trim().slice(0, 500);
    }
  }
  if (!result.description) {
    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
    if (ogDesc?.[1]) {
      result.description = ogDesc[1].replace(/\s+/g, ' ').trim().slice(0, 1000);
    }
  }

  return result;
}

/**
 * Fetch page metadata (title, description) with SSRF safeguards.
 * Returns null on any error (network, timeout, parse, etc.).
 */
export async function fetchPageMetadata(url: string): Promise<PageMetadata | null> {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return null;
  }

  const hostname = parsed.hostname;
  if (!hostname) return null;

  try {
    await resolveAndCheckHost(hostname);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response: Response | null = null;
    let currentUrl = trimmed;
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
        const nextStr = nextUrl.toString();
        if (nextStr === currentUrl) return null;
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return null;
        await resolveAndCheckHost(nextUrl.hostname);
        currentUrl = nextStr;
        redirectCount++;
        continue;
      }

      response = res;
      break;
    }

    if (!response) return null;
    if (!response.ok) return null;

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      return extractMetadataFromHtml(
        new TextDecoder().decode(buffer.slice(0, MAX_RESPONSE_BYTES))
      );
    }
    const html = new TextDecoder().decode(buffer);
    return extractMetadataFromHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
