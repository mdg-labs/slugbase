import { useTranslation } from "react-i18next";

import type { DashboardBookmark } from "./dashboard.types.js";
import { ZapIcon } from "lucide-react";

export type DashboardQuickAccessProps = {
  bookmarks: DashboardBookmark[];
};

function openBookmark(bookmark: DashboardBookmark): void {
  if (bookmark.slug && bookmark.forwardingEnabled) {
    window.open(`/go/${bookmark.slug}`, "_blank", "noopener,noreferrer");
    return;
  }
  window.open(bookmark.url, "_blank", "noopener,noreferrer");
}

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
        <ul className="m-0 list-none p-0">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id}>
              <button
                type="button"
                className="flex w-full items-center gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-4 text-left transition-colors duration-micro last:border-b-0 hover:bg-raised-2"
                onClick={() => {
                  openBookmark(bookmark);
                }}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-fg">
                  {bookmark.title}
                </span>
                <span className="font-mono text-small font-medium text-accent-text">
                  /go/{bookmark.slug}
                </span>
                <span className="font-mono text-[10px] font-medium text-fg-subtle">
                  {bookmark.accessCount}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
