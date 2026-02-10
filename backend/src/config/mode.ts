/**
 * SlugBase runtime mode: SELFHOSTED (default) or CLOUD (SaaS).
 * Import this module only after load-env.js has run (e.g. from index.ts).
 */

const raw = (process.env.SLUGBASE_MODE || 'selfhosted').toLowerCase().trim();
export const mode: 'selfhosted' | 'cloud' = raw === 'cloud' ? 'cloud' : 'selfhosted';
export const isCloud: boolean = mode === 'cloud';
export const isSelfhosted: boolean = mode === 'selfhosted';
