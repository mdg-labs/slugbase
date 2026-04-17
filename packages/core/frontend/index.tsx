/**
 * @slugbase/core/frontend – re-exports App and createApiClient for self-hosted and cloud apps.
 * Published package includes frontend/src (copied at publish); in-repo use copy-core-dist or alias to root frontend.
 * When embedding, the host must initialize i18n and provide a single Router; see https://github.com/mdg-labs/slugbase-docs-internal/blob/main/docs/core-frontend-embedding.mdx
 */

export { default as App } from './src/App';
export { createApiClient } from './src/api/client';
