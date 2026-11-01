import { useConfig } from "../config/config-context.tsx";

/** The documentation site when the server names no usable base URL (doc 03 "App shell", doc 09 section 3.5). */
export const DEFAULT_DOCS_BASE_URL = "https://slugbase.app/docs";

/**
 * The stable `/docs/<route>` help routes the app links to (doc 09 section 3.5). The landing page is the base URL itself,
 * so its route is empty. Each page group adds the routes it links to.
 */
export const DOCS_ROUTES = {
  home: "",
  gettingStarted: "getting-started",
  selfHosting: "self-hosting",
} as const;

export type DocsRoute = (typeof DOCS_ROUTES)[keyof typeof DOCS_ROUTES];

/** Attributes of every link that leaves the app for the documentation site. */
export const DOCS_LINK_PROPS = { rel: "noopener noreferrer", target: "_blank" } as const;

/**
 * The docs base URL without a trailing slash, credentials, query string or fragment. Anything that is not an `http` or
 * `https` URL is replaced by the default site, so a configured `javascript:` address never becomes a link.
 */
export function normalizeDocsBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return DEFAULT_DOCS_BASE_URL;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return DEFAULT_DOCS_BASE_URL;
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/** The address of a documentation page: the base URL followed by the route, or the base URL alone without one. */
export function buildDocsUrl(baseUrl: string, route: DocsRoute = DOCS_ROUTES.home): string {
  const base = normalizeDocsBaseUrl(baseUrl);
  return route === "" ? base : `${base}/${route}`;
}

/** `docsUrl(route?)` over the `docsBaseUrl` of `GET /api/config`. */
export function useDocsUrl(): (route?: DocsRoute) => string {
  const { docsBaseUrl } = useConfig();
  return (route) => buildDocsUrl(docsBaseUrl, route);
}
