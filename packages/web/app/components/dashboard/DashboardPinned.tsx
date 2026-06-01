import { useTranslate } from "@tolgee/react";
import { Link } from "react-router";
import { useState } from "react";

import { formatRelativeTime } from "./dashboard.utils.js";
import type { DashboardBookmark } from "./dashboard.types.js";

export type DashboardPinnedProps = {
  bookmarks: DashboardBookmark[];
};

function PinFavicon({ url, size = 22 }: { url: string; size?: number }) {
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
          fontSize: Math.max(9, Math.round(size * 0.44)),
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

export function DashboardPinned({ bookmarks }: DashboardPinnedProps) {
  const { t } = useTranslate();

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-pinned"
    >
      <div className="flex items-center justify-between gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg" style={{ fontSize: "var(--text-body-lg)" }}>
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
        <div className="grid grid-cols-1 gap-sp-4 p-sp-5 sm:grid-cols-2">
          {bookmarks.map((bookmark) => {
            const relative = formatRelativeTime(bookmark.lastAccessedAt);
            return (
              <button
                key={bookmark.id}
                type="button"
                className="flex flex-col gap-sp-3 rounded-md border border-[color:var(--border-subtle)] bg-raised-2 p-sp-5 text-left transition-colors duration-micro hover:border-[color:var(--border)]"
                onClick={() => {
                  openBookmark(bookmark);
                }}
              >
                <span className="flex items-center gap-sp-3">
                  <PinFavicon url={bookmark.url} size={22} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">
                    {bookmark.title}
                  </span>
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
