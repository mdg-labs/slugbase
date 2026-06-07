import { useTranslate } from "@tolgee/react";
import { Badge, Kbd, ThemeSwitcher } from "@slugbase/ui";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { useListPageMeta } from "./list/ListPageMetaProvider.js";

export type AppTopBarProps = {
  /** Display name of the signed-in user */
  userName: string;
  /** Email of the signed-in user */
  userEmail: string;
  /** Open the ⌘K command palette */
  onOpenPalette: () => void;
  /** Open the new-bookmark modal */
  onNewBookmark: () => void;
  /** i18n labels for ThemeSwitcher */
  themeLabels: {
    group: string;
    light: string;
    dark: string;
    auto: string;
  };
};

/* ─── Icon helpers ──────────────────────────────────────────────── */

function SearchIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2.25" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden className="h-[14px] w-[14px] shrink-0 text-fg-subtle" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" strokeLinecap="round" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Route → breadcrumb mapping ────────────────────────────────── */

type Breadcrumb = {
  icon: React.ReactNode;
  label: string;
  sub: string | null;
};

function useLocationIcon() {
  return (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0 text-accent-text" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 21V12h6v9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function useBreadcrumbs(): Breadcrumb {
  const { t } = useTranslate();
  const location = useLocation();

  const bookmarkIcon = (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0 text-accent-text" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const folderIcon = (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0 text-accent-text" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const hashIcon = (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0 text-accent-text" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M4 9h16M4 15h16M10 3l-4 18M14 3l-4 18" strokeLinecap="round" />
    </svg>
  );
  const settingsIcon = (
    <svg aria-hidden className="h-[15px] w-[15px] shrink-0 text-accent-text" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const homeIcon = useLocationIcon();
  const pathname = location.pathname;

  if (pathname.startsWith("/bookmarks")) {
    return {
      icon: bookmarkIcon,
      label: t("app.shell.nav.bookmarks"),
      sub: t("sharing.scope.all"),
    };
  }
  if (pathname.startsWith("/folders")) {
    return {
      icon: folderIcon,
      label: t("app.shell.nav.folders"),
      sub: t("sharing.scope.all_folders"),
    };
  }
  if (pathname.startsWith("/tags")) {
    return {
      icon: hashIcon,
      label: t("app.shell.nav.tags"),
      sub: t("tags.list.title"),
    };
  }
  if (pathname.startsWith("/settings")) {
    return { icon: settingsIcon, label: t("app.shell.nav.settings"), sub: null };
  }
  return { icon: homeIcon, label: t("app.shell.nav.home"), sub: null };
}

/* ─── Avatar dropdown ───────────────────────────────────────────── */

function AvatarDropdown({
  userName,
  userEmail,
}: {
  userName: string;
  userEmail: string;
}) {
  const { t } = useTranslate();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const initials = userName
    .split(" ")
    .map((n) => n.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("");

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onOutsideClick);
    return () => { document.removeEventListener("mousedown", onOutsideClick); };
  }, [open]);

  function MenuItem({
    icon,
    label,
    onClick,
    hint,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    hint?: string;
  }) {
    return (
      <button
        className="flex w-full items-center gap-sp-3 rounded-md px-sp-3 py-[7px] text-left text-[length:var(--text-body)] text-fg-muted transition-colors hover:bg-raised-2 hover:text-fg"
        onClick={() => { setOpen(false); onClick?.(); }}
      >
        {icon}
        <span className="flex-1">{label}</span>
        {hint && <span className="font-mono text-[length:var(--text-micro)] text-fg-subtle">{hint}</span>}
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        className="inline-grid h-[32px] w-[32px] place-items-center rounded-full bg-accent-subtle font-mono text-[13px] font-semibold text-accent-text transition-colors hover:bg-accent-subtle-hover"
        onClick={() => { setOpen((o) => !o); }}
        aria-label={t("app.shell.topbar.avatar_label")}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {initials || "?"}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 flex w-[220px] flex-col rounded-lg border border-[color:var(--border)] bg-overlay p-sp-1"
          style={{ boxShadow: "var(--shadow-popover)" }}
        >
          {/* User info header */}
          <div className="flex items-center gap-sp-3 px-sp-3 pb-sp-3 pt-sp-2">
            <span className="inline-grid h-[32px] w-[32px] shrink-0 place-items-center rounded-full bg-accent-subtle font-mono text-[13px] font-semibold text-accent-text">
              {initials || "?"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[length:var(--text-body)] font-semibold text-fg">{userName}</p>
              <p className="truncate text-[length:var(--text-micro)] text-fg-subtle">{userEmail}</p>
            </div>
          </div>
          <div className="my-[2px] h-px bg-[color:var(--border-subtle)]" />
          <div className="flex flex-col">
            <MenuItem
              icon={<UserIcon />}
              label={t("app.shell.topbar.account")}
              onClick={() => { void navigate("/settings/account"); }}
            />
            <MenuItem
              icon={<SlidersIcon />}
              label={t("app.shell.topbar.preferences")}
              onClick={() => { void navigate("/settings/account?tab=preferences"); }}
            />
          </div>
          <div className="my-[2px] h-px bg-[color:var(--border-subtle)]" />
          <div className="flex flex-col">
            <MenuItem
              icon={<LogOutIcon />}
              label={t("app.shell.topbar.sign_out")}
              onClick={() => { void navigate("/logout"); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main top bar component ────────────────────────────────────── */

export function AppTopBar({
  userName,
  userEmail,
  onOpenPalette,
  onNewBookmark,
  themeLabels,
}: AppTopBarProps) {
  const { t } = useTranslate();
  const breadcrumb = useBreadcrumbs();
  const listMeta = useListPageMeta();
  const subLabel = listMeta.subLabel ?? breadcrumb.sub;
  const count = listMeta.count;

  return (
    <div className="flex w-full items-center gap-sp-5 px-sp-6">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-sp-2 shrink-0" aria-label={t("app.shell.topbar.breadcrumbs_label")}>
        {breadcrumb.icon}
        <span className="font-semibold text-[length:var(--text-body)] text-fg">{breadcrumb.label}</span>
        {subLabel ? (
          <>
            <ChevronRightIcon />
            <span className="text-[length:var(--text-body)] text-fg-muted">{subLabel}</span>
            {count != null ? (
              <Badge variant="neutral" className="ml-[2px]">
                {count}
              </Badge>
            ) : null}
          </>
        ) : null}
      </div>

      {/* ⌘K cmd-trigger */}
      <button
        className="flex flex-1 max-w-[420px] items-center gap-sp-4 h-[34px] px-sp-4 rounded-md bg-raised border border-[color:var(--border-subtle)] text-fg-subtle transition-colors hover:border-[color:var(--border)] hover:bg-raised-2"
        onClick={onOpenPalette}
        aria-label={t("app.shell.topbar.search_label")}
      >
        <SearchIcon />
        <span className="flex-1 text-left text-[length:var(--text-body)]">
          {t("app.shell.topbar.search_placeholder")}
        </span>
        <Kbd>⌘K</Kbd>
      </button>

      {/* Right-side actions */}
      <div className="ml-auto flex items-center gap-sp-4 shrink-0">
        {/* Theme toggle */}
        <ThemeSwitcher labels={themeLabels} />

        {/* New bookmark */}
        <button
          className="inline-flex items-center gap-sp-2 rounded-md bg-accent px-sp-4 py-sp-2 text-[length:var(--text-small)] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          onClick={onNewBookmark}
          aria-label={t("app.shell.topbar.new_bookmark")}
        >
          <PlusIcon />
          <span>{t("app.shell.topbar.new_bookmark")}</span>
          <Kbd
            className="border-accent-border bg-accent-border text-accent-fg/80"
          >
            C
          </Kbd>
        </button>

        {/* Avatar */}
        <AvatarDropdown userName={userName} userEmail={userEmail} />
      </div>
    </div>
  );
}
