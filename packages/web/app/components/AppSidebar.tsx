import { useTranslation } from "react-i18next";
import { useState } from "react";
import { NavLink, useLocation } from "react-router";

import { isPlanGatingEnabled } from "../lib/billing-config.js";
import { LegalLinks } from "./LegalLinks.js";
import type { WorkspaceListItem } from "./workspace-switcher/workspace-switcher-api.js";
import { WorkspaceSwitcherPanel } from "./workspace-switcher/WorkspaceSwitcherPanel.js";

export type SidebarFolder = {
  id: string;
  name: string;
  /** CSS color value or null - renders as a dot */
  color: string | null;
  bookmarkCount: number;
};

export type AppSidebarProps = {
  workspace: { id: string; name: string; plan: "free" | "personal" | "team" };
  workspaces: WorkspaceListItem[];
  folders: SidebarFolder[];
  bookmarkTotal: number;
  /** Free plan usage: current bookmark count used */
  bookmarksUsed?: number;
  /** Free plan cap */
  bookmarkCap?: number;
  onUpgrade?: () => void;
};

/* ─── Icon helpers (Lucide-compatible inline SVGs) ─────────────── */

function HomeIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 21V12h6v9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M4 9h16M4 15h16M10 3l-4 18M14 3l-4 18" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75M9 7a4 4 0 100 8 4 4 0 000-8z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronsUpDownIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0 text-fg-subtle" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M7 15l5 5 5-5M7 9l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LifeBuoyIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M14.83 9.17l4.24-4.24M4.93 19.07l4.24-4.24" strokeLinecap="round" />
    </svg>
  );
}

function SlugIcon() {
  return (
    <svg aria-hidden className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M4 8h16M4 16h16" strokeLinecap="round" />
      <path d="M8 4v16M16 4v16" strokeLinecap="round" />
    </svg>
  );
}

function AlertTriangleIcon() {
  return (
    <svg aria-hidden className="h-[12px] w-[12px] shrink-0 text-danger-text" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Nav item ──────────────────────────────────────────────────── */

function NavItem({
  to,
  icon,
  label,
  count,
  end = false,
  testid,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
  end?: boolean;
  testid?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      data-testid={testid}
      className={({ isActive }) =>
        [
          "flex items-center gap-sp-4 rounded-md px-sp-4 py-[7px] text-[length:var(--text-body)] transition-colors",
          isActive
            ? "bg-accent-subtle font-medium text-accent-text [&>svg]:text-accent-text"
            : "text-fg-muted hover:bg-raised hover:text-fg [&>svg]:text-fg-subtle",
        ].join(" ")
      }
    >
      {icon}
      <span>{label}</span>
      {count != null && (
        <span className="ml-auto font-mono text-[length:var(--text-micro)] bg-raised px-[6px] py-[2px] rounded-full text-fg-subtle [.active_&]:bg-accent-subtle/80 [.active_&]:text-accent-text">
          {count}
        </span>
      )}
    </NavLink>
  );
}

/* ─── Sub-nav folder item ───────────────────────────────────────── */

function FolderNavItem({
  folder,
  activeFolder,
}: {
  folder: SidebarFolder;
  activeFolder: boolean;
}) {
  const dotColor = folder.color ?? "var(--fg-subtle)";
  return (
    <NavLink
      to={`/bookmarks?folderId=${folder.id}`}
      className={[
        "flex items-center gap-sp-4 rounded-md pl-[30px] pr-sp-4 py-[7px] text-[length:var(--text-body)] transition-colors",
        activeFolder
          ? "bg-accent-subtle font-medium text-accent-text"
          : "text-fg-muted hover:bg-raised hover:text-fg",
      ].join(" ")}
    >
      <span
        className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
        style={{ background: dotColor }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
      {folder.bookmarkCount > 0 && (
        <span className="ml-auto font-mono text-[length:var(--text-micro)] bg-raised px-[6px] py-[2px] rounded-full text-fg-subtle">
          {folder.bookmarkCount}
        </span>
      )}
    </NavLink>
  );
}

/* ─── Main sidebar component ────────────────────────────────────── */

export function AppSidebar({
  workspace,
  workspaces,
  folders,
  bookmarkTotal,
  bookmarksUsed,
  bookmarkCap = 50,
  onUpgrade,
}: AppSidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const currentFolderId = new URLSearchParams(location.search).get("folderId");
  const used = bookmarksUsed ?? bookmarkTotal;
  const pct = Math.min(100, Math.round((used / bookmarkCap) * 100));
  const showMeter = isPlanGatingEnabled() && workspace.plan === "free";

  const wsLetter = workspace.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <>
      <div className="flex flex-1 flex-col min-h-0">
        {/* ── Workspace switcher trigger ─────────────────────────── */}
        <button
          className="flex items-center gap-sp-4 rounded-md m-sp-4 px-sp-3 py-sp-3 transition-colors hover:bg-raised cursor-pointer"
          onClick={() => { setSwitcherOpen(true); }}
          aria-label={t("app.workspace_switcher.open_label")}
          aria-expanded={switcherOpen}
        >
          <span
            className="inline-grid h-[32px] w-[32px] shrink-0 place-items-center rounded-lg"
            aria-hidden
          >
            <img
              src="/slugbase_icon.svg"
              alt=""
              className="h-[20px] w-[20px]"
              onError={(e) => {
                /* fall back to letter avatar if icon fails */
                const t = e.currentTarget.parentElement;
                if (t) {
                  t.style.background = "var(--accent-subtle)";
                  t.textContent = wsLetter;
                  t.style.fontSize = "14px";
                  t.style.fontWeight = "700";
                }
              }}
            />
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[length:var(--text-body)] font-semibold text-fg leading-tight">
              {workspace.name}
            </span>
            {isPlanGatingEnabled() && (
              <span className="block text-[length:var(--text-micro)] text-fg-subtle capitalize leading-tight">
                {workspace.plan} {t("app.workspace_switcher.plan_suffix")}
              </span>
            )}
          </span>
          <ChevronsUpDownIcon />
        </button>

        {/* ── Primary navigation ─────────────────────────────────── */}
        <nav
          className="flex-1 overflow-y-auto px-sp-4 py-sp-3"
          aria-label={t("app.shell.nav.aria_label")}
          data-testid="sidebar-nav"
        >
          <div className="flex flex-col gap-[2px]">
            <NavItem to="/" end icon={<HomeIcon />} label={t("app.shell.nav.home")} testid="sidebar-dashboard-link" />
            <NavItem
              to="/bookmarks"
              icon={<BookmarkIcon />}
              label={t("app.shell.nav.bookmarks")}
              count={bookmarkTotal > 0 ? bookmarkTotal : undefined}
              testid="sidebar-bookmarks-link"
            />
            <NavItem
              to="/go"
              icon={<SlugIcon />}
              label={t("app.shell.nav.go")}
              testid="sidebar-go-link"
            />
            <NavItem to="/folders" icon={<FolderIcon />} label={t("app.shell.nav.folders")} />
            <NavItem to="/tags" icon={<HashIcon />} label={t("app.shell.nav.tags")} />
          </div>

          {/* Folder sub-nav */}
          {folders.length > 0 && (
            <div className="mt-sp-5">
              <p className="mb-sp-2 px-sp-4 text-[length:var(--text-micro)] font-medium uppercase tracking-wide text-fg-subtle">
                {t("app.shell.nav.folders_section")}
              </p>
              <div className="flex flex-col gap-[2px]">
                {folders.map((f) => (
                  <FolderNavItem
                    key={f.id}
                    folder={f}
                    activeFolder={currentFolderId === f.id}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Account section */}
          <div className="mt-sp-5">
            <p className="mb-sp-2 px-sp-4 text-[length:var(--text-micro)] font-medium uppercase tracking-wide text-fg-subtle">
              {t("app.shell.nav.account_section")}
            </p>
            <div className="flex flex-col gap-[2px]">
              <NavItem
                to="/settings/account"
                icon={<SettingsIcon />}
                label={t("app.shell.nav.settings")}
              />
              <NavItem
                to="/settings/members"
                icon={<UsersIcon />}
                label={t("app.shell.nav.members")}
              />
            </div>
          </div>
        </nav>

        {/* ── Sidebar footer ─────────────────────────────────────── */}
        <div className="mt-auto border-t border-[color:var(--border-subtle)] p-sp-4 flex flex-col gap-sp-4" data-testid="sidebar-user-menu">
          {showMeter && (
            <div className="flex flex-col gap-sp-2">
              <div className="flex items-center justify-between">
                <span className="text-[length:var(--text-micro)] text-fg-subtle">
                  <b className="text-fg">{used}</b> / {bookmarkCap}{" "}
                  {t("app.shell.usage.bookmarks_label")}
                </span>
              </div>
              {/* Usage meter */}
              <div className="h-[4px] overflow-hidden rounded-full bg-raised-2">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${String(pct)}%`,
                    background: pct >= 100
                      ? "var(--danger)"
                      : pct >= 90
                        ? "var(--warning)"
                        : "var(--accent)",
                  }}
                />
              </div>
              <div className="text-[length:var(--text-micro)] text-fg-subtle">
                {pct >= 100 ? (
                  <span className="flex items-center gap-sp-2">
                    <AlertTriangleIcon />
                    {t("app.shell.usage.limit_reached")}{" "}
                    <button
                      className="text-accent-text hover:underline"
                      onClick={onUpgrade}
                    >
                      {t("app.shell.usage.upgrade_cta")}
                    </button>
                  </span>
                ) : (
                  <span>
                    {t("app.shell.usage.remaining", {
                      remaining: String(bookmarkCap - used),
                    })}{" "}
                    <button
                      className="text-accent-text hover:underline"
                      onClick={onUpgrade}
                    >
                      {t("app.shell.usage.upgrade_cta")}
                    </button>
                  </span>
                )}
              </div>
            </div>
          )}

          <button className="flex items-center gap-sp-4 rounded-md px-sp-4 py-[7px] text-[length:var(--text-body)] text-fg-muted transition-colors hover:bg-raised hover:text-fg">
            <LifeBuoyIcon />
            {t("app.shell.nav.help")}
          </button>

          <LegalLinks variant="sidebar" />
        </div>
      </div>

      {/* ── Workspace switcher overlay ──────────────────────────── */}
      {switcherOpen && (
        <WorkspaceSwitcherPanel
          workspaces={workspaces}
          activeWorkspaceId={workspace.id}
          onClose={() => { setSwitcherOpen(false); }}
        />
      )}
    </>
  );
}
