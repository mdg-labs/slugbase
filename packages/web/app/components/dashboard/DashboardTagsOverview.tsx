import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { sortTagsByUsage } from "./dashboard.utils.js";
import type { DashboardTag } from "./dashboard.types.js";

export type DashboardTagsOverviewProps = {
  tags: DashboardTag[];
};

export function DashboardTagsOverview({ tags }: DashboardTagsOverviewProps) {
  const { t } = useTranslation();
  const topTags = sortTagsByUsage(tags).slice(0, 12);

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-tags-overview"
    >
      <div className="flex items-center justify-between gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg">
          <span aria-hidden>#</span>
          {t("dashboard.tags.title")}
        </h2>
        <Link
          to="/tags"
          className="text-small text-accent-text hover:underline"
        >
          {t("dashboard.tags.view_all")}
        </Link>
      </div>
      {topTags.length === 0 ? (
        <p className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.tags.empty")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-sp-3 p-sp-5">
          {topTags.map((tag) => (
            <Link
              key={tag.id}
              to="/tags"
              className="inline-flex h-6 items-center gap-[5px] rounded-sm border border-[color:var(--border-subtle)] bg-raised-2 px-sp-4 font-mono text-small font-medium text-fg-muted transition-colors duration-micro hover:border-[color:var(--accent-border)] hover:bg-accent-subtle hover:text-accent-text"
            >
              {tag.name}
              <span className="font-mono text-[10px] text-fg-faint">
                {tag.bookmarkCount}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
