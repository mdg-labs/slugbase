/**
 * SlugBase frontend runtime mode: self-hosted or cloud.
 * Derived from VITE_SLUGBASE_MODE at build time (cloud builds set it to 'cloud').
 */
const buildMode = import.meta.env.VITE_SLUGBASE_MODE === 'cloud' ? 'cloud' : 'selfhosted';
export const mode: 'selfhosted' | 'cloud' = buildMode;
export const isCloud = buildMode === 'cloud';
export const isSelfhosted = !isCloud;
