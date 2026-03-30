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

const defaultPlan: PlanInfo | null = null;
const PlanContext = createContext<PlanInfo | null>(defaultPlan);

export const isCloudMode = import.meta.env.VITE_SLUGBASE_MODE === 'cloud';

/** Cloud: AI admin + paid-only AI UX only when plan loaded and ai_available. Self-hosted: show when plan context absent or AI allowed on plan. */
export function showAdminAiNav(planInfo: PlanInfo | null): boolean {
  if (isCloudMode) return planInfo?.aiAvailable === true;
  return !planInfo || planInfo.aiAvailable;
}

export function PlanProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);

  useEffect(() => {
    if (!isCloudMode || !user) {
      setPlanInfo(null);
      return;
    }
    api
      .get<{ plan: string; bookmarkLimit: number | null; canShareWithTeams: boolean; ai_available?: boolean }>('/config/plan')
      .then((res) => {
        setPlanInfo({
          plan: res.data.plan ?? 'free',
          bookmarkLimit: res.data.bookmarkLimit ?? null,
          canShareWithTeams: res.data.canShareWithTeams === true,
          aiAvailable: res.data.ai_available === true,
        });
      })
      .catch(() => {
        // 404 or error when not in cloud or API unavailable: treat as no plan limits (self-hosted)
        setPlanInfo(null);
      });
  }, [user]);

  return <PlanContext.Provider value={planInfo}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanInfo | null {
  return useContext(PlanContext);
}
