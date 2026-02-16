/**
 * Plan-based helpers for Cloud mode pricing.
 * When plan is null (self-hosted or loading), treat as unrestricted.
 */

/** Free plan bookmark limit. Must match backend FREE_BOOKMARK_LIMIT. */
export const FREE_PLAN_BOOKMARK_LIMIT = 50;

export type PlanTier = 'free' | 'personal' | 'team';

export const canShareToTeams = (plan: string | null): boolean => !plan || plan === 'team';

export const canShareFolders = (plan: string | null): boolean => !plan || plan === 'team';

/**
 * Determines sharing capabilities based on mode and plan.
 * - Self-hosted: allow teams + users if teams exist
 * - Cloud team: allow teams + users
 * - Cloud free/personal: allow users only, no team sharing
 */
export function getSharingCapabilities(
  mode: 'selfhosted' | 'cloud',
  plan: PlanTier | null,
  hasTeams: boolean
): { allowShareToTeams: boolean; allowShareToUsers: boolean } {
  if (mode === 'selfhosted') {
    return {
      allowShareToTeams: hasTeams,
      allowShareToUsers: true,
    };
  }
  // Cloud
  if (plan === 'team') {
    return { allowShareToTeams: true, allowShareToUsers: true };
  }
  return { allowShareToTeams: false, allowShareToUsers: true };
}

/**
 * Can user create bookmarks? Considers free plan limit and grace period.
 * When freePlanGraceEndsAt is set and in the future, allows create even if over limit.
 */
export const canCreateBookmark = (
  _plan: string | null,
  count: number,
  limit: number | null,
  freePlanGraceEndsAt?: string | null
): boolean => {
  if (!limit) return true;
  if (count < limit) return true;
  if (freePlanGraceEndsAt) {
    const endsAt = new Date(freePlanGraceEndsAt).getTime();
    if (Date.now() < endsAt) return true;
  }
  return false;
};
