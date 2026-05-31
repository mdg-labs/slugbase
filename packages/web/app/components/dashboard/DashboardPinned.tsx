import { useTranslate } from "@tolgee/react";
import { Link } from "react-router";

import { formatRelativeTime } from "./dashboard.utils.js";
import type { DashboardBookmark } from "./dashboard.types.js";

export type DashboardPinnedProps = {
  bookmarks: DashboardBookmark[];
};

function openBookmark(bookmark: DashboardBookmark): void {
  if (bookmark.slug && bookmark.forwardingEnabled) {
    window.open(`/go/${bookmark.slug}`, "_blank", "noopener,noreferrer");
    return;
  }
  window.open(bookmark.url, "_blank", "noopener,noreferrer");
}

export function DashboardPinned({ bookmarks }: DashboardPinnedProps) {
  const { t } = useTranslate();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-pinned"
    >
      <div className="flex items-center justify-between gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg">
          <span aria-hidden>📌</span>
          {t("dashboard.pinned.title")}
        </h2>
        <Link
          to="/"
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
        <div className="grid grid-cols-1 gap-sp-4 p-sp-5 sm:grid-cols-2">
          {bookmarks.map((bookmark) => {
            const relative = formatRelativeTime(bookmark.lastAccessedAt);
            return (
              <button
                key={bookmark.id}
                type="button"
                className="flex flex-col gap-sp-3 rounded-md border border-[color:var(--border-subtle)] bg-raised-2 p-sp-5 text-left shadow-[inset_3px_0_0_var(--accent)] transition-colors duration-micro hover:border-[color:var(--border)]"
                onClick={() => {
                  openBookmark(bookmark);
                }}
              >
                <span className="truncate font-medium text-fg">
                  {bookmark.title}
                </span>
                <span className="flex flex-wrap items-center gap-sp-3">
                  {bookmark.slug ? (
                    <span className="font-mono text-[11px] text-accent-text">
                      /go/{bookmark.slug}
                    </span>
                  ) : null}
                  {relative ? (
                    <span className="ml-auto font-mono text-[11px] text-fg-faint">
                      {t("dashboard.pinned.last_accessed", { time: relative })}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
