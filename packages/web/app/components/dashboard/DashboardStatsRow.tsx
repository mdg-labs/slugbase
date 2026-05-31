import { useTranslate } from "@tolgee/react";
import { Link } from "react-router";

import type { DashboardCounts } from "./dashboard.types.js";

export type DashboardStatsRowProps = {
  counts: DashboardCounts;
};

type StatTileProps = {
  count: number;
  label: string;
  to: string;
  testId: string;
};

function StatTile({ count, label, to, testId }: StatTileProps) {
  return (
    <Link
      to={to}
      className="flex flex-col gap-sp-3 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6 transition-colors duration-micro hover:border-[color:var(--border)]"
      data-testid={testId}
    >
      <span
        className="font-mono font-semibold text-fg"
        style={{ fontSize: "28px", lineHeight: "1", letterSpacing: "-0.02em" }}
      >
        {count}
      </span>
      <span className="inline-flex items-center gap-sp-3 text-small text-fg-subtle">
        {label}
      </span>
    </Link>
  );
}

export function DashboardStatsRow({ counts }: DashboardStatsRowProps) {
  const { t } = useTranslate();

  return (
    <div
      className="mb-sp-7 grid grid-cols-1 gap-sp-5 sm:grid-cols-3"
      data-testid="dashboard-stats-row"
    >
      <StatTile
        count={counts.bookmarks}
        label={t("dashboard.stats.bookmarks")}
        to="/"
        testId="dashboard-stat-bookmarks"
      />
      <StatTile
        count={counts.folders}
        label={t("dashboard.stats.folders")}
        to="/folders"
        testId="dashboard-stat-folders"
      />
      <StatTile
        count={counts.tags}
        label={t("dashboard.stats.tags")}
        to="/tags"
        testId="dashboard-stat-tags"
      />
    </div>
  );
}
