/**
 * Plan-based helpers for Cloud mode pricing.
 * When plan is null (self-hosted or loading), treat as unrestricted.
 */

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

export const canCreateBookmark = (
  _plan: string | null,
  count: number,
  limit: number | null
): boolean => !limit || count < limit;
