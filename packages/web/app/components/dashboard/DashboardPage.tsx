import { useLoaderData } from "react-router";

import { DashboardEntitlementBanner } from "./DashboardEntitlementBanner.js";
import { DashboardFoldersOverview } from "./DashboardFoldersOverview.js";
import { DashboardOnboardingChecklist } from "./DashboardOnboardingChecklist.js";
import { DashboardPinned } from "./DashboardPinned.js";
import { DashboardQuickAccess } from "./DashboardQuickAccess.js";
import { DashboardRecent } from "./DashboardRecent.js";
import { DashboardSearchEntry } from "./DashboardSearchEntry.js";
import { DashboardSharingStats } from "./DashboardSharingStats.js";
import { DashboardStatsRow } from "./DashboardStatsRow.js";
import { DashboardTagsOverview } from "./DashboardTagsOverview.js";
import { resolveEntitlementBanner } from "./dashboard.utils.js";
import type { DashboardData } from "./dashboard.types.js";
import { useAppShellData } from "../../lib/session-client.js";

export function DashboardPage() {
  const data = useLoaderData<DashboardData>();
  const { user } = useAppShellData();
  const entitlementBanner = resolveEntitlementBanner(
    data.workspace.plan,
    data.counts.bookmarks,
  );

  return (
    <div data-testid="dashboard-page">
      {entitlementBanner ? (
        <DashboardEntitlementBanner banner={entitlementBanner} />
      ) : null}

      <DashboardSearchEntry />
      <DashboardStatsRow counts={data.counts} />

      <div className="grid items-start gap-sp-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-sp-7">
          <DashboardQuickAccess bookmarks={data.quickAccess} />
          <DashboardPinned bookmarks={data.pinned} />
          <DashboardRecent bookmarks={data.recent} />
        </div>

        <div className="flex flex-col gap-sp-7">
          <DashboardOnboardingChecklist
            data={data}
            checklistManual={user.dashboardChecklistManual}
            checklistDismissed={user.dashboardChecklistDismissed}
          />
          <DashboardTagsOverview tags={data.tags} />
          <DashboardFoldersOverview folders={data.folders} />
          <DashboardSharingStats counts={data.counts} />
        </div>
      </div>
    </div>
  );
}
