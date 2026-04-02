/**
 * Parse command-palette input for the same idiom as a browser custom search engine: `go <slug>`.
 * Also accepts a pasted app path `/go/<slug>`.
 */
/**
 * While typing a `go …` command, returns the slug prefix after `go` (may be empty).
 * Returns null if the query is not a go-command (e.g. `google`).
 */
export function parseGoCommandSlugPrefix(trimmed: string): string | null {
  const m = trimmed.match(/^go(?:$|\s+(.+))$/i);
  if (!m) return null;
  return m[1] != null ? m[1].trim() : '';
}

export function parseGoCommandQuery(trimmed: string): string | null {
  const goMatch = trimmed.match(/^go\s+(.+)$/i);
  if (goMatch) {
    const slug = goMatch[1].trim();
    return slug || null;
  }
  const pathMatch = trimmed.match(/^\/go\/([^/?#]+)$/);
  if (pathMatch) {
    try {
      const slug = decodeURIComponent(pathMatch[1]).trim();
      return slug || null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface AbsoluteUrlForGoSlugOptions {
  apiBaseUrl: string;
  /** Defaults to `window.location.hostname` in the browser. */
  hostname?: string;
  /** Defaults to `window.location.origin` when resolving relative fallbacks. */
  origin?: string;
}

/**
 * Absolute URL for a backend go path (`/go` or `/go/<encodedSlug>`) — same rules as ForwardingHandler.
 */
export function absoluteUrlForGoPath(
  goPath: string,
  { apiBaseUrl, hostname, origin }: AbsoluteUrlForGoSlugOptions
): string {
  const host =
    hostname ??
    (typeof window !== 'undefined' ? window.location.hostname : '');
  const isDevelopment = host === 'localhost';
  if (isDevelopment) {
    return `http://localhost:5000${goPath}`;
  }
  const base = (apiBaseUrl || '').replace(/\/+$/, '');
  if (base) {
    return `${base}${goPath}`;
  }
  const o =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  if (o) {
    return `${o}${goPath}`;
  }
  return goPath;
}

/** Absolute URL for GET /go/:slug on the API host. */
export function absoluteUrlForGoSlug(
  slug: string,
  opts: AbsoluteUrlForGoSlugOptions
): string {
  return absoluteUrlForGoPath(`/go/${encodeURIComponent(slug)}`, opts);
}
