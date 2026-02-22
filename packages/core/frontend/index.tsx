/**
 * @slugbase/core/frontend – re-exports App and createApiClient for self-hosted and cloud apps.
 * Published package includes frontend/src (copied at publish); in-repo use copy-core-dist or alias to root frontend.
 */

export { default as App } from './src/App';
export { createApiClient } from './src/api/client';
