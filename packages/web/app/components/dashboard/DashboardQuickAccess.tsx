import { useTranslation } from "react-i18next";
import { ZapIcon } from "lucide-react";

import { DashboardBookmarkGrid } from "./DashboardBookmarkGrid.js";
import type { DashboardBookmark } from "./dashboard.types.js";

export type DashboardQuickAccessProps = {
  bookmarks: DashboardBookmark[];
};

export function DashboardQuickAccess({ bookmarks }: DashboardQuickAccessProps) {
  const { t } = useTranslation();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-quick-access"
    >
      <div className="flex items-center justify-between gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg">
          <ZapIcon size={16} aria-hidden="true" />
          {t("dashboard.quick_access.title")}
        </h2>
        <span className="text-small text-fg-subtle">
          {t("dashboard.quick_access.subtitle")}
        </span>
      </div>
      {bookmarks.length === 0 ? (
        <p className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.quick_access.empty")}
        </p>
      ) : (
        <DashboardBookmarkGrid bookmarks={bookmarks} />
      )}
    </section>
  );
}
