import { useTranslation } from "react-i18next";
import { useState } from "react";

import { formatRelativeTime } from "./dashboard.utils.js";
import type { DashboardBookmark } from "./dashboard.types.js";

export type DashboardRecentProps = {
  bookmarks: DashboardBookmark[];
};

function RecentFavicon({ url, size = 20 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  let initial = "";
  try {
    initial = new URL(url).hostname.replace(/^www\./, "").slice(0, 1).toUpperCase();
  } catch {
    initial = url.slice(0, 1).toUpperCase();
  }

  if (failed || !url) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-md bg-[color:var(--canvas)] font-mono text-fg-faint"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, Math.round(size * 0.44)),
        }}
        aria-hidden
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={`/bookmarks/favicon?url=${encodeURIComponent(url)}`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className="shrink-0 rounded-md object-contain"
      style={{ width: size, height: size }}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

function openBookmark(bookmark: DashboardBookmark): void {
  if (bookmark.slug && bookmark.forwardingEnabled) {
    window.open(`/go/${bookmark.slug}`, "_blank", "noopener,noreferrer");
    return;
  }
  window.open(bookmark.url, "_blank", "noopener,noreferrer");
}

export function DashboardRecent({ bookmarks }: DashboardRecentProps) {
  const { t } = useTranslation();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-recent"
    >
      <div className="border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg" style={{ fontSize: "var(--text-body-lg)" }}>
          {t("dashboard.recent.title")}
        </h2>
      </div>
      {bookmarks.length === 0 ? (
        <p className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.recent.empty")}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {bookmarks.map((bookmark) => {
            const relative = formatRelativeTime(bookmark.lastAccessedAt);
            return (
              <li key={bookmark.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-4 text-left transition-colors duration-micro last:border-b-0 hover:bg-raised-2"
                  onClick={() => {
                    openBookmark(bookmark);
                  }}
                >
                  <RecentFavicon url={bookmark.url} size={20} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">
                    {bookmark.title}
                  </span>
                  {relative ? (
                    <span className="shrink-0 font-mono text-small text-fg-faint">
                      {t("dashboard.recent.last_accessed", { time: relative })}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
