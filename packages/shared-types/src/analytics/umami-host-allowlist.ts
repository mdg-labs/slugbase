/**
 * Build-time Umami script host allowlist (SEC-027).
 * The configured host origin is always permitted; extra origins may be listed explicitly.
 */

function normalizeOrigin(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Parses comma-separated HTTPS origins for Umami script loading. */
export function parseUmamiAllowedOrigins(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (!raw) {
    return allowed;
  }
  for (const part of raw.split(",")) {
    const origin = normalizeOrigin(part);
    if (origin) {
      allowed.add(origin);
    }
  }
  return allowed;
}

/** Resolves the effective allowlist for Umami script loading. */
export function buildUmamiHostAllowlist(
  configuredHost: string | undefined,
  extraOriginsRaw: string | undefined,
): Set<string> {
  const explicit = parseUmamiAllowedOrigins(extraOriginsRaw);
  if (explicit.size > 0) {
    return explicit;
  }

  const allowed = new Set<string>();
  const host = configuredHost?.replace(/\/$/, "");
  const hostOrigin = host ? normalizeOrigin(host) : undefined;
  if (hostOrigin) {
    allowed.add(hostOrigin);
  }
  return allowed;
}

/** Returns true when the Umami host is HTTPS and its origin is allowlisted. */
export function isUmamiHostAllowed(
  configuredHost: string,
  allowlist: Set<string>,
): boolean {
  const origin = normalizeOrigin(configuredHost.replace(/\/$/, ""));
  return origin !== undefined && allowlist.has(origin);
}
