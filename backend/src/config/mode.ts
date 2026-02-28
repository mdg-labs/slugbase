/**
 * SlugBase runtime mode: self-hosted (default) or cloud when SLUGBASE_MODE=cloud.
 */
export const isCloud = process.env.SLUGBASE_MODE === 'cloud';
export const mode: 'selfhosted' | 'cloud' = isCloud ? 'cloud' : 'selfhosted';
export const isSelfhosted = !isCloud;
