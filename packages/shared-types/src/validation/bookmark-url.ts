export const BOOKMARK_HTTP_URL_MESSAGE = "Only http and https URLs are supported";

/** True when the value is an absolute http or https URL (spec §6.4, §8). */
export function isBookmarkHttpUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("//")) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
