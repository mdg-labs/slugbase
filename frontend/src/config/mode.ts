/**
 * SlugBase runtime mode: SELFHOSTED (default) or CLOUD (SaaS).
 * Set at build time via VITE_SLUGBASE_MODE.
 */

const raw = (import.meta.env.VITE_SLUGBASE_MODE ?? 'selfhosted').toString().toLowerCase().trim();
export const mode: 'selfhosted' | 'cloud' = raw === 'cloud' ? 'cloud' : 'selfhosted';
export const isCloud: boolean = mode === 'cloud';
export const isSelfhosted: boolean = mode === 'selfhosted';
