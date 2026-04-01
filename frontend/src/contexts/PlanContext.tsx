/**
 * Cloud plan context: fetches plan from /api/config/plan when in cloud and user is authenticated.
 * Provides plan, bookmarkLimit, canShareWithTeams, aiAvailable for gating sharing UI, AI features, and usage.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from './AuthContext';

export interface PlanInfo {
  plan: string;
  bookmarkLimit: number | null;
  canShareWithTeams: boolean;
  /** In cloud: true when plan is personal, team, or supporter (AI suggestions available). */
  aiAvailable: boolean;
}

/** Self-hosted or logged-out cloud: no plan fetch. loading: cloud fetch in flight. ready: cloud fetch finished (success or pessimistic free on error). */
export type PlanLoadState = 'skipped' | 'loading' | 'ready';

const FREE_FALLBACK: PlanInfo = {
  plan: 'free',
  bookmarkLimit: 50,
  canShareWithTeams: false,
  aiAvailable: false,
};

interface PlanContextValue {
  planInfo: PlanInfo | null;
  planLoadState: PlanLoadState;
}

const PlanContext = createContext<PlanContextValue>({
  planInfo: null,
  planLoadState: 'skipped',
});

export const isCloudMode = import.meta.env.VITE_SLUGBASE_MODE === 'cloud';

/** Cloud: AI admin + paid-only AI UX only when plan loaded and ai_available. Self-hosted: show when plan context absent or AI allowed on plan. */
export function showAdminAiNav(planInfo: PlanInfo | null): boolean {
  if (isCloudMode) return planInfo?.aiAvailable === true;
  return !planInfo || planInfo.aiAvailable;
}

/** Admin Users tab: self-hosted always; cloud only after plan is known (any tier). */
export function showAdminMembersNav(planInfo: PlanInfo | null, planLoadState: PlanLoadState): boolean {
  if (!isCloudMode) return true;
  return planLoadState === 'ready' && planInfo !== null;
}

/** Admin Teams tab: self-hosted always; cloud only on Team plan after load. */
export function showAdminTeamsNav(planInfo: PlanInfo | null, planLoadState: PlanLoadState): boolean {
  if (!isCloudMode) return true;
  return planLoadState === 'ready' && planInfo?.plan === 'team';
}

/** Create org users / invites from admin UI: self-hosted always; cloud Team plan only. */
export function canInviteOrgUsers(planInfo: PlanInfo | null, planLoadState: PlanLoadState): boolean {
  if (!isCloudMode) return true;
  return planLoadState === 'ready' && planInfo?.plan === 'team';
}

/** First admin sub-route to open when the preferred tab is unavailable (index redirect, gates). */
export function getFirstAdminRedirectPath(
  planInfo: PlanInfo | null,
  planLoadState: PlanLoadState,
  options: {
    hideAdminOidcAndSmtp: boolean;
    extraAdminNavItems?: { path: string; label: string }[];
  },
): string {
  if (showAdminMembersNav(planInfo, planLoadState)) return 'members';
  if (!options.hideAdminOidcAndSmtp) return 'oidc';
  if (showAdminAiNav(planInfo)) return 'ai';
  const extra = options.extraAdminNavItems?.[0]?.path;
  if (extra) return extra;
  return 'ai';
}

export function PlanProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);
  const [planLoadState, setPlanLoadState] = useState<PlanLoadState>(() =>
    !isCloudMode || !user ? 'skipped' : 'loading',
  );

  useEffect(() => {
    if (!isCloudMode || !user) {
      setPlanInfo(null);
      setPlanLoadState('skipped');
      return;
    }
    setPlanLoadState('loading');
    setPlanInfo(null);
    api
      .get<{ plan: string; bookmarkLimit: number | null; canShareWithTeams: boolean; ai_available?: boolean }>(
        '/config/plan',
      )
      .then((res) => {
        setPlanInfo({
          plan: res.data.plan ?? 'free',
          bookmarkLimit: res.data.bookmarkLimit ?? null,
          canShareWithTeams: res.data.canShareWithTeams === true,
          aiAvailable: res.data.ai_available === true,
        });
        setPlanLoadState('ready');
      })
      .catch(() => {
        setPlanInfo({ ...FREE_FALLBACK });
        setPlanLoadState('ready');
      });
  }, [user]);

  return (
    <PlanContext.Provider value={{ planInfo, planLoadState }}>{children}</PlanContext.Provider>
  );
}

export function usePlan(): PlanInfo | null {
  return useContext(PlanContext).planInfo;
}

export function usePlanLoadState(): PlanLoadState {
  return useContext(PlanContext).planLoadState;
}
