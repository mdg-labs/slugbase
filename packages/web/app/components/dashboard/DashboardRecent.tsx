import { useTranslation } from "react-i18next";

import { DashboardBookmarkGrid } from "./DashboardBookmarkGrid.js";
import type { DashboardBookmark } from "./dashboard.types.js";

export type DashboardRecentProps = {
  bookmarks: DashboardBookmark[];
};

export function DashboardRecent({ bookmarks }: DashboardRecentProps) {
  const { t } = useTranslation();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-recent"
    >
      <div className="border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2
          className="m-0 flex items-center gap-sp-3 font-semibold text-fg"
          style={{ fontSize: "var(--text-body-lg)" }}
        >
          {t("dashboard.recent.title")}
        </h2>
      </div>
      {bookmarks.length === 0 ? (
        <p className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.recent.empty")}
        </p>
      ) : (
        <DashboardBookmarkGrid bookmarks={bookmarks} />
      )}
    </section>
  );
}
