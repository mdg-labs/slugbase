import { useTranslate } from "@tolgee/react";
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

export function DashboardPage() {
  const { t } = useTranslate();
  const data = useLoaderData<DashboardData>();
  const entitlementBanner = resolveEntitlementBanner(
    data.workspace.plan,
    data.counts.bookmarks,
  );

  return (
    <div data-testid="dashboard-page">
      <header className="mb-sp-7">
        <h1 className="m-0 font-semibold text-fg" style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}>
          {t("dashboard.title")}
        </h1>
        <p className="mt-sp-2 text-body text-fg-muted">
          {t("dashboard.subtitle", { workspace: data.workspace.name })}
        </p>
      </header>

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
          <DashboardOnboardingChecklist data={data} />
          <DashboardTagsOverview tags={data.tags} />
          <DashboardFoldersOverview folders={data.folders} />
          <DashboardSharingStats counts={data.counts} />
        </div>
      </div>
    </div>
  );
}
