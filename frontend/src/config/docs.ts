/**
 * Documentation URLs at docs.slugbase.app.
 * Paths differ by mode: selfhosted (/selfhosted/...) vs cloud (/cloud/...).
 */
import { isCloud } from './mode';

const DOCS_BASE = 'https://docs.slugbase.app';

/** URL to the API Reference section (selfhosted or cloud). */
export function getDocsApiReferenceUrl(): string {
  const path = isCloud ? 'cloud/api-reference' : 'selfhosted/api-reference';
  return `${DOCS_BASE}/${path}`;
}

/** URL to docs home/overview (selfhosted intro or cloud overview). */
export function getDocsBaseUrl(): string {
  const path = isCloud ? 'cloud/overview' : 'selfhosted/intro';
  return `${DOCS_BASE}/${path}`;
}
