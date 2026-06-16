import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { DashboardBookmarkGrid } from "./DashboardBookmarkGrid.js";
import type { DashboardBookmark } from "./dashboard.types.js";

export type DashboardPinnedProps = {
  bookmarks: DashboardBookmark[];
};

export function DashboardPinned({ bookmarks }: DashboardPinnedProps) {
  const { t } = useTranslation();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-pinned"
    >
      <div className="flex items-center justify-between gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2
          className="m-0 flex items-center gap-sp-3 font-semibold text-fg"
          style={{ fontSize: "var(--text-body-lg)" }}
        >
          {t("dashboard.pinned.title")}
        </h2>
        <Link
          to="/bookmarks?pinned=true"
          className="text-small text-accent-text hover:underline"
        >
          {t("dashboard.pinned.view_all")}
        </Link>
      </div>
      {bookmarks.length === 0 ? (
        <p className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.pinned.empty")}
        </p>
      ) : (
        <DashboardBookmarkGrid bookmarks={bookmarks} />
      )}
    </section>
  );
}
