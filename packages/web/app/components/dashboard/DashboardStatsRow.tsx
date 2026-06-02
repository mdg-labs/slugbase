import { useTranslate } from "@tolgee/react";
import { Link } from "react-router";

import type { DashboardCounts } from "./dashboard.types.js";

export type DashboardStatsRowProps = {
  counts: DashboardCounts;
};

function BookmarkStatIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 2h10a1 1 0 011 1v10.5l-6-3-6 3V3a1 1 0 011-1z" />
    </svg>
  );
}

function FolderStatIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 4a1 1 0 011-1h3.5l1.5 2H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
    </svg>
  );
}

function TagStatIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <line x1="6" y1="2.5" x2="5" y2="13.5" />
      <line x1="11" y1="2.5" x2="10" y2="13.5" />
      <line x1="3" y1="6" x2="13.5" y2="6" />
      <line x1="2.5" y1="10" x2="13" y2="10" />
    </svg>
  );
}

type StatTileProps = {
  count: number;
  label: string;
  icon: React.ReactNode;
  to: string;
  testId: string;
};

function StatTile({ count, label, icon, to, testId }: StatTileProps) {
  return (
    <Link
      to={to}
      className="flex flex-col gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6 transition-colors duration-micro hover:border-[color:var(--border)]"
      data-testid={testId}
    >
      <span
        className="font-mono font-semibold text-fg"
        style={{ fontSize: "28px", lineHeight: "1", letterSpacing: "-0.02em" }}
      >
        {count}
      </span>
      <span className="inline-flex items-center gap-sp-3 text-small text-fg-subtle">
        <span className="text-fg-subtle">{icon}</span>
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
        icon={<BookmarkStatIcon />}
        to="/bookmarks"
        testId="dashboard-stat-bookmarks"
      />
      <StatTile
        count={counts.folders}
        label={t("dashboard.stats.folders")}
        icon={<FolderStatIcon />}
        to="/folders"
        testId="dashboard-stat-folders"
      />
      <StatTile
        count={counts.tags}
        label={t("dashboard.stats.tags")}
        icon={<TagStatIcon />}
        to="/tags"
        testId="dashboard-stat-tags"
      />
    </div>
  );
}
