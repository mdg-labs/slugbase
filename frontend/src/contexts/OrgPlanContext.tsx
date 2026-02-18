import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../api/client';
import { useAuth } from './AuthContext';
import { isCloud } from '../config/mode';
import { FREE_PLAN_BOOKMARK_LIMIT } from '../utils/plan';

export type PlanTier = 'free' | 'personal' | 'team';

interface OrgPlanContextType {
  plan: PlanTier | null;
  bookmarkCount: number;
  bookmarkLimit: number | null;
  freePlanGraceEndsAt: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const OrgPlanContext = createContext<OrgPlanContextType | undefined>(undefined);

export function OrgPlanProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<PlanTier | null>(null);
  const [bookmarkCount, setBookmarkCount] = useState(0);
  const [bookmarkLimit, setBookmarkLimit] = useState<number | null>(null);
  const [freePlanGraceEndsAt, setFreePlanGraceEndsAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!isCloud || !user) {
      setPlan(null);
      setBookmarkCount(0);
      setBookmarkLimit(null);
      setFreePlanGraceEndsAt(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api.get('/organizations/me');
      const data = res.data;
      const rawPlan = data?.plan;
      const effectivePlan: PlanTier =
        rawPlan === 'early_supporter' ? 'personal' : rawPlan === 'free' || rawPlan === 'personal' || rawPlan === 'team' ? rawPlan : 'free';
      setPlan(effectivePlan);
      setBookmarkCount(data?.bookmark_count ?? 0);
      const rawLimit = data?.bookmark_limit ?? null;
      const limit = effectivePlan === 'free' && rawLimit != null
        ? Math.min(rawLimit, FREE_PLAN_BOOKMARK_LIMIT)
        : rawLimit;
      setBookmarkLimit(limit);
      setFreePlanGraceEndsAt(data?.free_plan_grace_ends_at ?? null);
    } catch {
      setPlan(null);
      setBookmarkCount(0);
      setBookmarkLimit(null);
      setFreePlanGraceEndsAt(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [user?.id]);

  return (
    <OrgPlanContext.Provider
      value={{
        plan,
        bookmarkCount,
        bookmarkLimit,
        freePlanGraceEndsAt,
        loading,
        refresh: load,
      }}
    >
      {children}
    </OrgPlanContext.Provider>
  );
}

export function useOrgPlan() {
  const context = useContext(OrgPlanContext);
  if (context === undefined) {
    throw new Error('useOrgPlan must be used within an OrgPlanProvider');
  }
  return context;
}
