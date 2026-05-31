import { useTranslate } from "@tolgee/react";
import { Link } from "react-router";

import { sortFoldersByUsage } from "./dashboard.utils.js";
import type { DashboardFolder } from "./dashboard.types.js";

export type DashboardFoldersOverviewProps = {
  folders: DashboardFolder[];
};

export function DashboardFoldersOverview({
  folders,
}: DashboardFoldersOverviewProps) {
  const { t } = useTranslate();
  const topFolders = sortFoldersByUsage(folders).slice(0, 6);

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-folders-overview"
    >
      <div className="flex items-center justify-between gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex items-center gap-sp-3 font-semibold text-fg">
          <span aria-hidden>📁</span>
          {t("dashboard.folders.title")}
        </h2>
        <Link
          to="/folders"
          className="text-small text-accent-text hover:underline"
        >
          {t("dashboard.folders.view_all")}
        </Link>
      </div>
      {topFolders.length === 0 ? (
        <p className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.folders.empty")}
        </p>
      ) : (
        <ul className="m-0 list-none p-sp-5">
          {topFolders.map((folder) => (
            <li key={folder.id}>
              <Link
                to="/folders"
                className="flex items-center gap-sp-4 rounded-md px-sp-4 py-sp-4 transition-colors duration-micro hover:bg-raised-2"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-fg">
                  {folder.name}
                </span>
                <span className="font-mono text-small font-medium text-fg-subtle">
                  {folder.bookmarkCount}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
