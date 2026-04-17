/**
 * SlugBase frontend runtime mode: self-hosted or cloud.
 * Derived from VITE_SLUGBASE_MODE at build time (cloud builds set it to 'cloud').
 *
 * Expected per shipped artifact:
 * - slugbase registry image / Dockerfile: VITE_SLUGBASE_MODE=selfhosted (see .github/workflows/docker-build-push.yml build-args).
 * - slugbase-cloud web app: cloud (see slugbase-cloud vite.config.ts).
 * - packages/core embed (vite.core-embed.config.ts): defaults to cloud for hosted-product embed; override at build for self-hosted embed tests.
 */
const buildMode = import.meta.env.VITE_SLUGBASE_MODE === 'cloud' ? 'cloud' : 'selfhosted';
export const mode: 'selfhosted' | 'cloud' = buildMode;
export const isCloud = buildMode === 'cloud';
export const isSelfhosted = !isCloud;
