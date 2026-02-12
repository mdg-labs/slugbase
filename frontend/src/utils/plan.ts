/**
 * Plan-based helpers for Cloud mode pricing.
 * When plan is null (self-hosted or loading), treat as unrestricted.
 */

export const canShareToTeams = (plan: string | null): boolean => !plan || plan === 'team';

export const canShareFolders = (plan: string | null): boolean => !plan || plan === 'team';

export const canCreateBookmark = (
  _plan: string | null,
  count: number,
  limit: number | null
): boolean => !limit || count < limit;
