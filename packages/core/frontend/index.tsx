/**
 * @slugbase/core/frontend – re-exports App and createApiClient for self-hosted and cloud apps.
 * In-repo: resolves to root frontend src. Published: package must include or reference built frontend.
 */

export { default as App } from '../../frontend/src/App';
export { createApiClient } from '../../frontend/src/api/client';
