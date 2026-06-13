/**
 * Canonicalizes a bookmark destination URL for cache-key stability (spec §11.2).
 * Trims input, validates http/https, and lowercases the hostname.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.href;
}
