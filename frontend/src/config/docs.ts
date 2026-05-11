/**
 * Documentation URLs at docs.slugbase.app.
 * Paths differ by mode: selfhosted (/selfhosted/...) vs cloud (/cloud/...).
 * Operation slugs match Documentation.AI pages generated from OpenAPI in slugbase-docs.
 */
import { isCloud } from './mode';

const DOCS_BASE = 'https://docs.slugbase.app';

/** Documented API operation path segments under .../api-reference/<slug> (from published docs). */
export const DOCS_API_OPERATIONS = {
  csrfToken: 'get-api-csrf-token',
  listTokens: 'get-api-tokens',
} as const;

/** URL to the API Reference section (selfhosted or cloud). */
export function getDocsApiReferenceUrl(): string {
  const path = isCloud ? 'cloud/api-reference' : 'selfhosted/api-reference';
  return `${DOCS_BASE}/${path}`;
}

/**
 * Deep link to a single operation page under API Reference, e.g. get-api-csrf-token.
 * @param operationSlug last path segment (no leading slash)
 */
export function getDocsApiReferenceOperationUrl(operationSlug: string): string {
  const base = getDocsApiReferenceUrl().replace(/\/$/, '');
  const slug = operationSlug.replace(/^\//, '');
  return `${base}/${slug}`;
}

/** URL to docs home/overview (selfhosted intro or cloud overview). */
export function getDocsBaseUrl(): string {
  const path = isCloud ? 'cloud/overview' : 'selfhosted/intro';
  return `${DOCS_BASE}/${path}`;
}
