import { useTranslate } from "@tolgee/react";
import { Link } from "react-router";

import type { DashboardCounts } from "./dashboard.types.js";

export type DashboardSharingStatsProps = {
  counts: Pick<DashboardCounts, "sharedWithMe" | "sharedByMe">;
};

type ShareRowProps = {
  label: string;
  count: number;
  to: string;
  testId: string;
};

function ShareRow({ label, count, to, testId }: ShareRowProps) {
  return (
    <Link
      to={to}
      className="flex items-center gap-sp-4 border-b border-[color:var(--border-subtle)] py-sp-4 text-body text-fg-muted transition-colors duration-micro last:border-b-0 hover:text-fg"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span className="font-mono font-semibold text-fg">{count}</span>
      <span className="text-fg-faint" aria-hidden>
        →
      </span>
    </Link>
  );
}

export function DashboardSharingStats({ counts }: DashboardSharingStatsProps) {
  const { t } = useTranslate();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-sharing-stats"
    >
      <div className="border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg">
          <span aria-hidden>↗</span>
          {t("dashboard.sharing.title")}
        </h2>
      </div>
      <div className="px-sp-6 py-sp-5">
        <ShareRow
          label={t("dashboard.sharing.shared_with_you")}
          count={counts.sharedWithMe}
          to="/"
          testId="dashboard-sharing-with-you"
        />
        <ShareRow
          label={t("dashboard.sharing.shared_by_you")}
          count={counts.sharedByMe}
          to="/"
          testId="dashboard-sharing-by-you"
        />
      </div>
    </section>
  );
}
