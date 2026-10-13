/** The documentation site when the server names no other (doc 03 "App shell"). */
export const DEFAULT_DOCS_BASE_URL = "https://slugbase.app/docs";

/**
 * The address of a documentation page: the docs base URL followed by the
 * page's route (doc 09 section 3.5). Without a route it is the docs home.
 */
export function docsUrl(baseUrl: string = DEFAULT_DOCS_BASE_URL, route = ""): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = route.replace(/^\/+/, "");
  return path === "" ? base : `${base}/${path}`;
}
