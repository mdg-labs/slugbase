import type { DashboardChecklistManual } from "@slugbase/shared-types";

import {
  CHECKLIST_DISMISSED_KEY,
  CHECKLIST_STORAGE_KEY,
  type ChecklistItemId,
} from "../components/dashboard/dashboard.constants.js";
import { updateAccountPreferences } from "../routes/settings/account/account-api.js";

const ONBOARDING_DONE_KEY = "sb_onboarding_done";

export function isOnboardingComplete(onboardingCompletedAt: number | null): boolean {
  return onboardingCompletedAt != null;
}

export function syncOnboardingDoneCache(onboardingCompletedAt: number | null): void {
  if (typeof window === "undefined") return;
  try {
    if (onboardingCompletedAt != null) {
      window.localStorage.setItem(ONBOARDING_DONE_KEY, "true");
    } else {
      window.localStorage.removeItem(ONBOARDING_DONE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export async function persistOnboardingComplete(): Promise<void> {
  syncOnboardingDoneCache(Date.now());
  await updateAccountPreferences({ onboardingCompleted: true });
}

export function syncChecklistCache(
  dismissed: boolean,
  manual: DashboardChecklistManual,
): void {
  if (typeof window === "undefined") return;
  try {
    const manualOnly = Object.fromEntries(
      (Object.keys(manual) as ChecklistItemId[]).map((id) => [id, manual[id]]),
    );
    window.localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(manualOnly));
    window.localStorage.setItem(
      CHECKLIST_DISMISSED_KEY,
      dismissed ? "true" : "false",
    );
  } catch {
    /* ignore */
  }
}

export async function persistChecklistDismissed(dismissed: boolean): Promise<void> {
  await updateAccountPreferences({ dashboardChecklistDismissed: dismissed });
}

export async function persistChecklistManual(
  manual: Partial<DashboardChecklistManual>,
): Promise<void> {
  await updateAccountPreferences({ dashboardChecklistManual: manual });
}
