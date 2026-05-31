import type { PageMetadata } from "./metadata.types.js";

const META_TAG_PATTERN =
  /<meta\b[^>]*(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;
const TITLE_TAG_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    )
    .trim();
}

function readAttribute(tag: string, attribute: string): string | null {
  const pattern = new RegExp(
    `${attribute}\\s*=\\s*(["'])([^"']*)\\1`,
    "i",
  );
  const match = tag.match(pattern);
  return match?.[2] ?? null;
}

function collectMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of html.matchAll(META_TAG_PATTERN)) {
    const tag = match[0];
    const key = readAttribute(tag, "property") ?? readAttribute(tag, "name");
    const content = readAttribute(tag, "content");
    if (key && content) {
      tags.set(key.toLowerCase(), decodeHtmlEntities(content));
    }
  }
  return tags;
}

function pickMeta(
  tags: Map<string, string>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = tags.get(key);
    if (value) return value;
  }
  return null;
}

function extractTitleTag(html: string): string | null {
  const match = html.match(TITLE_TAG_PATTERN);
  if (!match?.[1]) return null;
  return decodeHtmlEntities(match[1].replace(/\s+/g, " "));
}

function extractFaviconHref(html: string, pageUrl: string): string | null {
  const links: Array<{ rel: string; href: string }> = [];
  for (const match of html.matchAll(LINK_TAG_PATTERN)) {
    const tag = match[0];
    const rel = readAttribute(tag, "rel");
    const href = readAttribute(tag, "href");
    if (rel && href) {
      links.push({ rel: rel.toLowerCase(), href });
    }
  }

  const iconLink =
    links.find((link) => link.rel === "apple-touch-icon") ??
    links.find((link) => link.rel.includes("icon"));

  if (iconLink) {
    return resolveUrl(iconLink.href, pageUrl);
  }

  try {
    const origin = new URL(pageUrl).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function parsePageMetadata(html: string, pageUrl: string): PageMetadata {
  const tags = collectMetaTags(html);
  const title =
    pickMeta(tags, ["og:title", "twitter:title"]) ?? extractTitleTag(html);
  const description = pickMeta(tags, [
    "og:description",
    "twitter:description",
    "description",
  ]);
  const siteName = pickMeta(tags, [
    "og:site_name",
    "application-name",
    "apple-mobile-web-app-title",
  ]);

  return {
    title,
    description,
    siteName,
    faviconUrl: extractFaviconHref(html, pageUrl),
  };
}

export function resolveFaviconUrl(pageUrl: string, html: string): string | null {
  return extractFaviconHref(html, pageUrl);
}
