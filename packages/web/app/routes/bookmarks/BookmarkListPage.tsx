import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigate, useNavigation, useRevalidator } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { Button, ConfirmDialog, EmptyState } from "@slugbase/ui";

import { ScopeFilter } from "../../components/sharing/ScopeFilter.js";
import { ScopeIcon } from "../../components/sharing/ScopeIcon.js";
import { resolveResourceSharingScope } from "../../components/sharing/sharing.utils.js";
import { useWorkspaceEntitlements } from "../../components/sharing/use-workspace-entitlements.js";
import { useBookmarkModal } from "../../components/bookmark-modal/BookmarkModalProvider.js";
import { useAppToast } from "../../components/feedback/AppToastProvider.js";
import { ImportDialog } from "../../components/import/ImportDialog.js";
import type { ImportResult } from "../../components/onboarding/import-api.js";
import { navigateToExternalUrl } from "../../lib/safe-external-url.js";
import {
  bulkAddTags,
  bulkDeleteBookmarks,
  bulkMoveToFolder,
  bulkPinBookmarks,
  bulkRemoveTags,
  deleteBookmark,
  loadToolbarOptions,
  type ToolbarOption,
} from "./bookmarks-api.js";
import {
  buildBookmarkListSearch,
  type BookmarkListData,
  type BookmarkListItem,
  type ToolbarFolder,
} from "./bookmarks-loader.js";
import { BookmarkFavicon } from "./BookmarkFavicon.js";
import { BookmarkListSkeleton } from "./BookmarkListSkeleton.js";
import { SectionHead } from "../../components/list/SectionHead.js";

const VIEW_STORAGE_KEY = "sb:bookmarks:view";

/* ── Inline SVG icons ──────────────────────────────────────── */
function GridIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="3" y1="12" x2="13" y2="12" />
    </svg>
  );
}
function PinIcon({ filled }: { filled?: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 2 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 1.5l5 5-3 1-2.5 2.5-1 3-4.5-4.5 3-1z" />
      <line x1="1.5" y1="14.5" x2="6" y2="10" />
    </svg>
  );
}
function ChevronDownIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
    >
      <path d="M2 4.5l4 4 4-4" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <line x1="2" y1="2" x2="10" y2="10" />
      <line x1="10" y1="2" x2="2" y2="10" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 6.5l3 3 5-6" />
    </svg>
  );
}
function LinkOffIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M2 12L12 2" />
      <path d="M5.5 8.5A3 3 0 009 5l1.5-1.5A4.24 4.24 0 0016.5 9.5" />
      <path d="M8 10.5a3 3 0 01-3-3L3.5 9A4.24 4.24 0 007.5 15" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 1.5C5.5 4 5 5.5 5 7s.5 3 2 5.5M7 1.5C8.5 4 9 5.5 9 7s-.5 3-2 5.5" />
      <line x1="1.5" y1="7" x2="12.5" y2="7" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3.5h10M5 3.5V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1M5.5 6v4M8.5 6v4M3 3.5l.7 7.5a.5.5 0 00.5.5h5.6a.5.5 0 00.5-.5L11 3.5" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 3a1 1 0 011-1H5l1.5 2H11.5a1 1 0 011 1v5.5a1 1 0 01-1 1h-9a1 1 0 01-1-1V3z" />
    </svg>
  );
}
function HashIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <line x1="5" y1="2" x2="4" y2="12" />
      <line x1="10" y1="2" x2="9" y2="12" />
      <line x1="2.5" y1="5.5" x2="11.5" y2="5.5" />
      <line x1="2" y1="8.5" x2="11" y2="8.5" />
    </svg>
  );
}
function SortIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <line x1="2" y1="4" x2="12" y2="4" />
      <line x1="2" y1="7" x2="10" y2="7" />
      <line x1="2" y1="10" x2="7" y2="10" />
    </svg>
  );
}
function ZapIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 1.5L3 8h4l-1.5 4.5L12 6H8L9.5 1.5z" />
    </svg>
  );
}
function AlertTriangleIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 1.5L1.5 12h11L7 1.5z" />
      <line x1="7" y1="5.5" x2="7" y2="8" />
      <circle cx="7" cy="10" r=".5" fill="currentColor" />
    </svg>
  );
}

/* ── Simple hook for outside-click close ────────────────────── */
function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) handler();
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [active, handler, ref]);
}

/* ── Chip Dropdown ──────────────────────────────────────────── */
type ChipDropdownProps = {
  label: React.ReactNode;
  active?: boolean;
  align?: "left" | "right";
  width?: number;
  children: React.ReactNode;
  testId?: string;
};

function ChipDropdown({
  label,
  active,
  align = "left",
  width = 220,
  children,
  testId,
}: ChipDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeHandler = useCallback(() => { setOpen(false); }, []);
  useClickOutside(ref, closeHandler, open);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={[
          "inline-flex items-center gap-sp-3 rounded-md border px-sp-4 py-sp-3 text-small",
          active
            ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-accent-text"
            : "border-[color:var(--border)] bg-[color:var(--raised)] text-fg-muted hover:text-fg",
        ].join(" ")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        {label}
        <ChevronDownIcon />
      </button>
      {open ? (
        <div
          className="absolute top-[calc(100%+4px)] z-[80] overflow-hidden rounded-lg border border-[color:var(--border-strong)] bg-overlay shadow-overlay"
          style={{
            [align]: 0,
            minWidth: width,
          }}
          role="menu"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function MenuHead({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="px-sp-4 py-sp-2 text-small font-medium uppercase tracking-wide text-fg-subtle"
      style={{ fontSize: "var(--text-caption)" }}
    >
      {children}
    </p>
  );
}

function MenuItem({
  children,
  icon,
  checked,
  onClick,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  checked?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full items-center gap-sp-3 px-sp-4 py-sp-3 text-left text-small text-fg-muted hover:bg-[color:var(--raised)] hover:text-fg"
      onClick={onClick}
    >
      {icon ? (
        <span className="text-fg-subtle">{icon}</span>
      ) : null}
      <span className="flex-1">{children}</span>
      {checked ? (
        <span className="text-accent-text">
          <CheckIcon />
        </span>
      ) : null}
    </button>
  );
}

/* ── Relative time formatting ────────────────────────────────── */
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${String(sec)}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${String(min)}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${String(hr)}h`;
    return `${String(Math.floor(hr / 24))}d`;
  } catch {
    return "";
  }
}

/* ── Tag chip ────────────────────────────────────────────────── */
function TagChip({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center gap-sp-1 rounded border border-[color:var(--border-subtle)] bg-[color:var(--raised-2)] px-sp-3 py-sp-1 font-mono text-fg-subtle"
      style={{ fontSize: 11 }}
    >
      <HashIcon />
      {name}
    </span>
  );
}

/* ── Bookmark card (grid view) ─────────────────────────────── */
function BookmarkCard({
  bookmark,
  selected,
  bulkSelectMode,
  onToggleSelect,
  onOpenUrl,
  onPin,
  onEdit,
  onDelete,
  currentUserId,
}: {
  bookmark: BookmarkListItem;
  selected: boolean;
  bulkSelectMode: boolean;
  onToggleSelect: () => void;
  onOpenUrl: (url: string) => void;
  onPin: (pinned: boolean) => void;
  onEdit: (bookmark: BookmarkListItem) => void;
  onDelete: (bookmark: BookmarkListItem) => void;
  currentUserId: string | null;
}) {
  const { t } = useTranslation();
  const itemScope = resolveResourceSharingScope(
    bookmark.userId,
    currentUserId ?? "",
    bookmark.shareGrantCount,
  );
  const relative = formatRelativeTime(bookmark.lastAccessedAt ?? bookmark.createdAt);

  const handleCardClick = () => {
    if (bulkSelectMode) {
      onToggleSelect();
    } else {
      onOpenUrl(bookmark.url);
    }
  };

  return (
    <div
      className={[
        "relative flex cursor-pointer flex-col gap-sp-4 overflow-hidden rounded-lg border bg-raised p-sp-5 transition-colors duration-micro",
        selected
          ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)]"
          : "border-[color:var(--border)] hover:border-[color:var(--border-strong)]",
        bookmark.pinned
          ? "shadow-[inset_3px_0_0_var(--accent)]"
          : "",
      ].join(" ")}
      role="article"
      data-testid={`bookmark-card-${bookmark.id}`}
      onClick={handleCardClick}
    >
      {/* Top row: favicon + title */}
      <div className="flex items-start gap-sp-3">
        <BookmarkFavicon title={bookmark.title} url={bookmark.url} size={32} className="mt-[2px]" />
        <div className="min-w-0 flex-1" style={{ paddingRight: bulkSelectMode ? 60 : 20 }}>
          <p
            className="truncate font-medium text-fg"
            style={{ fontSize: "var(--text-body)" }}
          >
            {bookmark.title}
          </p>
        </div>
        {/* Bulk-select checkbox (top-right, next to menu) */}
        {bulkSelectMode ? (
          <span
            className={[
              "absolute right-sp-10 top-sp-3 grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md border transition-all duration-micro",
              selected
                ? "border-[color:var(--accent-border)] bg-accent text-accent-fg opacity-100"
                : "border-[color:var(--border-subtle)] bg-canvas opacity-100",
            ].join(" ")}
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect();
            }}
          >
            {selected ? <CheckIcon /> : null}
          </span>
        ) : null}
        {/* 3-dot menu */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="absolute right-sp-3 top-sp-4 rounded p-sp-1 text-fg-faint transition-colors duration-micro hover:bg-[color:var(--overlay)] hover:text-fg"
              title={t("bookmarks.list.action_more")}
              aria-label={t("bookmarks.list.action_more")}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <MoreHorizontalIcon size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 min-w-[180px] overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-2 shadow-lg"
              align="end"
              sideOffset={4}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onOpenUrl(bookmark.url);
                }}
              >
                <ExternalLinkIcon size={14} className="shrink-0 text-fg-muted" />
                {t("bookmarks.list.menu_open_url")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onEdit(bookmark);
                }}
              >
                <PencilIcon size={14} className="shrink-0 text-fg-muted" />
                {t("bookmarks.list.menu_edit")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onPin(!bookmark.pinned);
                }}
              >
                <PinIcon filled={bookmark.pinned} />
                {bookmark.pinned
                  ? t("bookmarks.list.menu_unpin")
                  : t("bookmarks.list.menu_pin")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-sp-2 border-t border-[color:var(--border)]" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-[color:var(--danger-text)] outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onDelete(bookmark);
                }}
              >
                <Trash2Icon size={14} className="shrink-0" />
                {t("bookmarks.list.menu_delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* URL row */}
      <div className="flex min-w-0 items-center gap-sp-2 text-fg-subtle">
        <GlobeIcon />
        <span
          className="flex-1 truncate"
          style={{ fontSize: "var(--text-small)" }}
        >
          {bookmark.url}
        </span>
      </div>

      {/* Slug line */}
      {bookmark.slug ? (
        <span
          className="inline-flex items-center gap-sp-2 self-start rounded border border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] px-sp-3 py-sp-1 font-mono text-accent-text"
          style={{ fontSize: 12 }}
        >
          <ArrowRightIcon size={12} />
          /go/{bookmark.slug}
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-sp-2 text-fg-faint"
          style={{ fontSize: 12 }}
        >
          <LinkOffIcon />
          <span>{t("bookmarks.list.no_slug")}</span>
        </span>
      )}

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-sp-3">
        {bookmark.folders.length > 0 ? (
          <span className="flex items-center gap-sp-2 text-fg-subtle" style={{ fontSize: 11 }}>
            <FolderIcon />
            <span>{bookmark.folders[0]?.name}</span>
          </span>
        ) : null}
        {bookmark.tags.slice(0, 2).map((tag) => (
          <TagChip key={tag.id} name={tag.name} />
        ))}
        {relative ? (
          <span
            className="ml-auto font-mono text-fg-faint"
            style={{ fontSize: 11 }}
          >
            {relative}
          </span>
        ) : null}
        <ScopeIcon scope={itemScope} />
      </div>
    </div>
  );
}

function ArrowRightIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 7h10M8 3l4 4-4 4" />
    </svg>
  );
}

/* ── Bookmark table row ──────────────────────────────────────── */
function BookmarkRow({
  bookmark,
  selected,
  bulkSelectMode,
  onToggleSelect,
  onOpenUrl,
  onPin,
  onEdit,
  onDelete,
  currentUserId,
  sort,
}: {
  bookmark: BookmarkListItem;
  selected: boolean;
  bulkSelectMode: boolean;
  onToggleSelect: () => void;
  onOpenUrl: (url: string) => void;
  onPin: (pinned: boolean) => void;
  onEdit: (bookmark: BookmarkListItem) => void;
  onDelete: (bookmark: BookmarkListItem) => void;
  currentUserId: string | null;
  sort: string;
}) {
  const { t } = useTranslation();
  const itemScope = resolveResourceSharingScope(
    bookmark.userId,
    currentUserId ?? "",
    bookmark.shareGrantCount,
  );
  const relative = formatRelativeTime(
    sort === "access-count-desc"
      ? bookmark.lastAccessedAt
      : (bookmark.lastAccessedAt ?? bookmark.createdAt),
  );

  const handleRowClick = () => {
    if (bulkSelectMode) {
      onToggleSelect();
    } else {
      onOpenUrl(bookmark.url);
    }
  };

  return (
    <div
      className={[
        "grid items-center gap-sp-3 border-b border-[color:var(--border-subtle)] px-sp-5 py-sp-4 transition-colors duration-micro last:border-b-0",
        "grid-cols-[20px_minmax(0,2.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_100px_40px]",
        selected
          ? "bg-[color:var(--accent-subtle)]"
          : "hover:bg-[color:var(--raised-2)] cursor-pointer",
      ].join(" ")}
      role="row"
      data-testid={`bookmark-row-${bookmark.id}`}
      onClick={handleRowClick}
    >
      {/* Checkbox - only visible in bulk-select mode */}
      <span
        className={[
          "grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-all duration-micro",
          !bulkSelectMode ? "invisible" : "",
          selected
            ? "border-[color:var(--accent-border)] bg-accent text-accent-fg"
            : "border-[color:var(--border-subtle)] bg-canvas",
        ].join(" ")}
        aria-hidden
      >
        {selected ? <CheckIcon /> : null}
      </span>

      {/* Title + URL */}
      <div className="flex min-w-0 items-center gap-sp-3">
        <BookmarkFavicon title={bookmark.title} url={bookmark.url} size={26} />
        <div className="min-w-0">
          <div
            className="flex items-center gap-sp-2 truncate font-medium text-fg"
            style={{ fontSize: "var(--text-body)" }}
          >
            {bookmark.pinned ? (
              <span className="text-accent-text">
                <PinIcon filled />
              </span>
            ) : null}
            <span className="truncate">{bookmark.title}</span>
          </div>
          <div
            className="truncate text-fg-subtle"
            style={{ fontSize: "var(--text-small)" }}
          >
            {bookmark.url}
          </div>
        </div>
      </div>

      {/* Slug */}
      <div>
        {bookmark.slug ? (
          <span
            className="inline-flex max-w-full items-center gap-sp-2 truncate font-mono text-accent-text"
            style={{ fontSize: 12 }}
          >
            <ArrowRightIcon size={12} />
            <span className="truncate">/go/{bookmark.slug}</span>
          </span>
        ) : (
          <span className="text-fg-faint" style={{ fontSize: 12 }}>
            -
          </span>
        )}
      </div>

      {/* Folder */}
      <div>
        {bookmark.folders.length > 0 ? (
          <span
            className="flex items-center gap-sp-2 text-fg-subtle"
            style={{ fontSize: 12 }}
          >
            <FolderIcon />
            <span className="truncate">{bookmark.folders[0]?.name}</span>
          </span>
        ) : (
          <span className="text-fg-faint" style={{ fontSize: 12 }}>
            -
          </span>
        )}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-sp-2">
        {bookmark.tags.slice(0, 2).map((tag) => (
          <TagChip key={tag.id} name={tag.name} />
        ))}
      </div>

      {/* Time / hits */}
      <div className="font-mono" style={{ fontSize: 12 }}>
        {sort === "access-count-desc" ? (
          <span className="text-warning-text">{bookmark.accessCount}</span>
        ) : (
          <span className="text-fg-subtle">{relative}</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-sp-2">
        <ScopeIcon scope={itemScope} />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="rounded p-sp-1 text-fg-faint transition-colors duration-micro hover:bg-[color:var(--overlay)] hover:text-fg"
              title={t("bookmarks.list.action_more")}
              aria-label={t("bookmarks.list.action_more")}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <MoreHorizontalIcon size={15} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 min-w-[180px] overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-2 shadow-lg"
              align="end"
              sideOffset={4}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onOpenUrl(bookmark.url);
                }}
              >
                <ExternalLinkIcon size={14} className="shrink-0 text-fg-muted" />
                {t("bookmarks.list.menu_open_url")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onEdit(bookmark);
                }}
              >
                <PencilIcon size={14} className="shrink-0 text-fg-muted" />
                {t("bookmarks.list.menu_edit")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onPin(!bookmark.pinned);
                }}
              >
                <PinIcon filled={bookmark.pinned} />
                {bookmark.pinned
                  ? t("bookmarks.list.menu_unpin")
                  : t("bookmarks.list.menu_pin")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-sp-2 border-t border-[color:var(--border)]" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-[color:var(--danger-text)] outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                style={{ fontSize: "var(--text-body)" }}
                onSelect={() => {
                  onDelete(bookmark);
                }}
              >
                <Trash2Icon size={14} className="shrink-0" />
                {t("bookmarks.list.menu_delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}

/* ── Table header ────────────────────────────────────────────── */
function TableHead({
  sort,
  setSort,
  bulkSelectMode,
  allSelected,
  someSelected,
  onToggleAll,
}: {
  sort: string;
  setSort: (s: string) => void;
  bulkSelectMode: boolean;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
}) {
  const { t } = useTranslation();
  function SortCol({
    id,
    label,
  }: {
    id: string;
    label: string;
  }) {
    return (
      <button
        type="button"
        className={[
          "flex items-center gap-sp-2 text-left text-small font-medium",
          sort === id ? "text-fg" : "text-fg-subtle hover:text-fg",
        ].join(" ")}
        onClick={() => {
          setSort(id);
        }}
      >
        {label}
        {sort === id ? (
          <svg
            aria-hidden
            viewBox="0 0 10 10"
            width={10}
            height={10}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <path d="M2 4l3 3 3-3" />
          </svg>
        ) : null}
      </button>
    );
  }

  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-sp-3 border-b border-[color:var(--border-subtle)] bg-[color:var(--raised)] px-sp-5 py-sp-3"
      style={{
        gridTemplateColumns:
          "20px minmax(0,2.5fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 100px 40px",
      }}
    >
      <span
        className={[
          "grid h-5 w-5 shrink-0 place-items-center rounded-md border cursor-pointer transition-all duration-micro",
          !bulkSelectMode ? "invisible" : "",
          allSelected || someSelected
            ? "border-[color:var(--accent-border)] bg-accent text-accent-fg"
            : "border-[color:var(--border-subtle)] bg-canvas",
        ].join(" ")}
        aria-hidden
        onClick={onToggleAll}
      >
        {allSelected ? <CheckIcon /> : someSelected ? "–" : null}
      </span>
      <SortCol id="title-asc" label={t("bookmarks.list.col_title")} />
      <div className="text-small font-medium text-fg-subtle">
        {t("bookmarks.list.col_slug")}
      </div>
      <div className="text-small font-medium text-fg-subtle">
        {t("bookmarks.list.col_folder")}
      </div>
      <div className="text-small font-medium text-fg-subtle">
        {t("bookmarks.list.col_tags")}
      </div>
      <SortCol id="last-accessed-desc" label={t("bookmarks.list.col_accessed")} />
      <div />
    </div>
  );
}

/* ── Entitlement cap banner ──────────────────────────────────── */
function BookmarkCapBanner({
  total,
  cap,
}: {
  total: number;
  cap: number;
}) {
  const { t } = useTranslation();
  const remaining = cap - total;
  const atCap = remaining <= 0;
  const approaching = !atCap && remaining <= 10;

  if (!atCap && !approaching) return null;

  return (
    <div
      className={[
        "flex items-center gap-sp-5 rounded-lg border px-sp-6 py-sp-5",
        atCap
          ? "border-[color:rgba(240,104,107,0.32)] bg-[linear-gradient(100deg,var(--danger-subtle),transparent_70%)]"
          : "border-[color:var(--accent-border)] bg-[linear-gradient(100deg,var(--accent-subtle),transparent_70%)]",
      ].join(" ")}
      data-testid="bookmark-cap-banner"
    >
      <span
        className={[
          "grid h-9 w-9 shrink-0 place-items-center rounded-md",
          atCap
            ? "bg-danger text-[color:var(--danger-fg)]"
            : "bg-accent text-accent-fg",
        ].join(" ")}
      >
        {atCap ? <AlertTriangleIcon /> : <ZapIcon />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-fg" style={{ fontSize: "var(--text-body-lg)" }}>
          {atCap
            ? t("bookmarks.list.cap_at_cap_title")
            : t("bookmarks.list.cap_approaching_title", { count: remaining })}
        </p>
        <p className="mt-sp-2 text-small text-fg-muted">
          {atCap
            ? t("bookmarks.list.cap_at_cap_body", { cap })
            : t("bookmarks.list.cap_approaching_body", { cap, used: total })}
        </p>
      </div>
      <Button variant="primary" className="shrink-0 text-small">
        {t("bookmarks.list.cap_upgrade_action")}
      </Button>
    </div>
  );
}

/* ── Bulk tag multi-select section ──────────────────────────── */
function BulkTagSection({
  heading,
  tags,
  confirmLabel,
  onConfirm,
  testId,
}: {
  heading: string;
  tags: ToolbarOption[];
  confirmLabel: string;
  onConfirm: (tagIds: string[]) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size === 0) return;
    onConfirm([...selected]);
    setSelected(new Set());
  };

  return (
    <div data-testid={testId}>
      <MenuHead>{heading}</MenuHead>
      {tags.length === 0 ? (
        <p className="px-sp-4 py-sp-2 text-fg-faint" style={{ fontSize: "var(--text-caption)" }}>
          {t("bookmarks.list.bulk_tags_empty")}
        </p>
      ) : (
        <div style={{ maxHeight: 160, overflowY: "auto" }}>
          {tags.map((tag) => {
            const isActive = selected.has(tag.id);
            return (
              <MenuItem
                key={tag.id}
                icon={
                  <span
                    className={[
                      "grid h-4 w-4 place-items-center rounded-sm border transition-colors",
                      isActive
                        ? "border-[color:var(--accent-border)] bg-accent text-accent-fg"
                        : "border-[color:var(--border-subtle)] bg-canvas",
                    ].join(" ")}
                  >
                    {isActive ? <CheckIcon /> : null}
                  </span>
                }
                onClick={() => {
                  toggle(tag.id);
                }}
              >
                <span className="font-mono" style={{ fontSize: 12 }}>
                  #{tag.name}
                </span>
              </MenuItem>
            );
          })}
        </div>
      )}
      <div className="border-t border-[color:var(--border)] px-sp-4 py-sp-2">
        <button
          type="button"
          disabled={selected.size === 0}
          className="rounded-md bg-accent px-sp-3 py-sp-1 text-small text-accent-fg disabled:opacity-40 hover:opacity-90"
          onClick={handleConfirm}
        >
          {confirmLabel} ({selected.size})
        </button>
      </div>
    </div>
  );
}

/* ── Bulk bar ───────────────────────────────────────────────── */
function BulkBar({
  count,
  onClear,
  onDelete,
  onPin,
  onUnpin,
  onMoveToFolder,
  onBulkAddTags,
  onBulkRemoveTags,
  folders,
  tags,
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onMoveToFolder: (folderId: string) => void;
  onBulkAddTags: (tagIds: string[]) => void;
  onBulkRemoveTags: (tagIds: string[]) => void;
  folders: ToolbarFolder[];
  tags: ToolbarOption[];
}) {
  const { t } = useTranslation();
  return (
    <div
      className="fixed bottom-sp-8 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-sp-3 rounded-full border border-[color:var(--border-strong)] bg-overlay px-sp-5 py-sp-4 shadow-overlay"
      data-testid="bulk-bar"
    >
      <span className="font-semibold text-small text-fg">
        {t("bookmarks.list.bulk_selected", { count })}
      </span>
      <span className="mx-sp-2 h-4 w-px bg-[color:var(--border-subtle)]" aria-hidden />
      <button
        type="button"
        className="inline-flex items-center gap-sp-2 rounded-md px-sp-3 py-sp-2 text-small text-fg-muted hover:bg-[color:var(--raised)] hover:text-fg"
        onClick={onPin}
      >
        <PinIcon filled />
        {t("bookmarks.list.bulk_pin")}
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-sp-2 rounded-md px-sp-3 py-sp-2 text-small text-fg-muted hover:bg-[color:var(--raised)] hover:text-fg"
        onClick={onUnpin}
      >
        <PinIcon />
        {t("bookmarks.list.bulk_unpin")}
      </button>
      {folders.length > 0 ? (
        <ChipDropdown
          label={
            <span className="flex items-center gap-sp-2">
              <FolderIcon />
              {t("bookmarks.list.bulk_move")}
            </span>
          }
          width={200}
          align="left"
          testId="bulk-move-trigger"
        >
          <MenuHead>{t("bookmarks.list.bulk_move_heading")}</MenuHead>
          {folders.map((folder) => (
            <MenuItem
              key={folder.id}
              onClick={() => {
                onMoveToFolder(folder.id);
              }}
            >
              {folder.name}
            </MenuItem>
          ))}
        </ChipDropdown>
      ) : null}
      {tags.length > 0 ? (
        <ChipDropdown
          label={
            <span className="flex items-center gap-sp-2">
              <HashIcon />
              {t("bookmarks.list.bulk_tags")}
            </span>
          }
          width={240}
          align="left"
          testId="bulk-tags-trigger"
        >
          <BulkTagSection
            heading={t("bookmarks.list.bulk_tags_add_heading")}
            tags={tags}
            confirmLabel={t("bookmarks.list.bulk_tags_add_confirm")}
            onConfirm={onBulkAddTags}
            testId="bulk-tags-add-section"
          />
          <div className="border-t border-[color:var(--border)]" />
          <BulkTagSection
            heading={t("bookmarks.list.bulk_tags_remove_heading")}
            tags={tags}
            confirmLabel={t("bookmarks.list.bulk_tags_remove_confirm")}
            onConfirm={onBulkRemoveTags}
            testId="bulk-tags-remove-section"
          />
        </ChipDropdown>
      ) : null}
      <button
        type="button"
        className="inline-flex items-center gap-sp-2 rounded-md px-sp-3 py-sp-2 text-small text-danger-text hover:bg-[color:var(--danger-subtle)]"
        onClick={onDelete}
      >
        <TrashIcon />
        {t("bookmarks.list.bulk_delete")}
      </button>
      <span className="mx-sp-2 h-4 w-px bg-[color:var(--border-subtle)]" aria-hidden />
      <button
        type="button"
        className="rounded-md p-sp-2 text-fg-subtle hover:bg-[color:var(--raised)] hover:text-fg"
        aria-label={t("bookmarks.list.bulk_clear")}
        onClick={onClear}
      >
        <XIcon />
      </button>
    </div>
  );
}

/* ── Pagination ─────────────────────────────────────────────── */
function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div
      className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-sp-5 py-sp-4 text-small text-fg-muted"
      data-testid="bookmark-pagination"
    >
      <span className="font-mono">
        {t("bookmarks.list.pagination_range", { from, to, total })}
      </span>
      <div className="flex items-center gap-sp-2">
        <button
          type="button"
          disabled={page <= 1}
          className="rounded-md border border-[color:var(--border)] px-sp-3 py-sp-2 disabled:opacity-40 hover:bg-[color:var(--raised-2)]"
          onClick={() => {
            onPage(page - 1);
          }}
        >
          ←
        </button>
        <span className="font-mono">
          {t("bookmarks.list.pagination_page", {
            page,
            total: totalPages,
          })}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          className="rounded-md border border-[color:var(--border)] px-sp-3 py-sp-2 disabled:opacity-40 hover:bg-[color:var(--raised-2)]"
          onClick={() => {
            onPage(page + 1);
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}

/* ── SORTS ───────────────────────────────────────────────────── */
const SORT_OPTIONS = [
  { id: "created-desc", labelKey: "bookmarks.list.sort_recent" },
  { id: "title-asc", labelKey: "bookmarks.list.sort_alpha" },
  { id: "access-count-desc", labelKey: "bookmarks.list.sort_used" },
  { id: "last-accessed-desc", labelKey: "bookmarks.list.sort_accessed" },
];

/* ── Main page ──────────────────────────────────────────────── */
export function BookmarkListPage() {
  const { t } = useTranslation();
  const data = useLoaderData<BookmarkListData>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const { currentUserId, canShare } = useWorkspaceEntitlements();
  const { open, openCreate, openEdit } = useBookmarkModal();
  const { showToast, showError } = useAppToast();
  const revalidator = useRevalidator();

  const [importOpen, setImportOpen] = useState(false);

  const atBookmarkCap =
    data.bookmarkCap !== null && data.workspaceBookmarkTotal >= data.bookmarkCap;

  const handleImportSuccess = useCallback(
    (result: ImportResult) => {
      if (result.successCount > 0) {
        if (result.capLimitedCount > 0) {
          showToast("bookmarks.import.toast_success_with_cap", {
            count: String(result.successCount),
            limited: String(result.capLimitedCount),
          });
        } else {
          showToast("bookmarks.import.toast_success", {
            count: String(result.successCount),
          });
        }
      } else if (result.capLimitedCount > 0) {
        showError(t("bookmarks.import.cap_blocked"));
      }
      void revalidator.revalidate();
    },
    [revalidator, showError, showToast, t],
  );

  // Revalidate when the bookmark modal closes (submit success or cancel)
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      // Modal just closed — re-fetch loader data so the list reflects any changes
      void revalidator.revalidate();
    }
    prevOpenRef.current = open;
  }, [open, revalidator]);

  // View toggle: prefer server param, but persist locally
  const [view, setView] = useState<"grid" | "table">(() => {
    if (data.view === "table") return "table";
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "table") return "table";
    }
    return data.defaultBookmarkView;
  });

  // Bulk-select mode
  const [bulkSelectMode, setBulkSelectMode] = useState(false);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Toolbar options loaded client-side
  const [toolbarOptions, setToolbarOptions] = useState<{
    folders: ToolbarOption[];
    tags: ToolbarOption[];
  }>({ folders: [], tags: [] });

  // Search input (debounced navigate)
  const [searchInput, setSearchInput] = useState(data.q);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLoading = navigation.state === "loading";
  const hasFilters =
    data.q.length > 0 ||
    !!data.folderId ||
    data.tagIds.length > 0 ||
    data.pinnedOnly ||
    data.scope !== "all";

  // Load toolbar options on mount
  useEffect(() => {
    void loadToolbarOptions().then(setToolbarOptions);
  }, []);

  // Persist view to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    }
  }, [view]);

  // Clear selection when data changes (page navigation)
  useEffect(() => {
    setSelectedIds(new Set());
  }, [data.page, data.q, data.folderId]);

  const buildUrl = useCallback(
    (overrides: {
      scope?: typeof data.scope;
      q?: string;
      folderId?: string | null;
      tagIds?: string[];
      pinned?: boolean;
      view?: "grid" | "table";
      page?: number;
      sort?: string;
    }) => {
      return `/bookmarks${buildBookmarkListSearch({
        scope: overrides.scope ?? data.scope,
        q: overrides.q !== undefined ? overrides.q : data.q,
        folderId: overrides.folderId !== undefined ? overrides.folderId : data.folderId,
        tagIds: overrides.tagIds ?? data.tagIds,
        pinned: overrides.pinned ?? data.pinnedOnly,
        view: overrides.view ?? (view !== "grid" ? view : undefined),
        page: overrides.page ?? 1,
        sort: overrides.sort ?? data.sort,
      })}`;
    },
    [data, view],
  );

  const navigateTo = (overrides: Parameters<typeof buildUrl>[0]) => {
    void navigate(buildUrl(overrides));
  };

  const handleSearch = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      navigateTo({ q: value, page: 1 });
    }, 350);
  };

  const handleScopeChange = (scope: typeof data.scope) => {
    navigateTo({ scope, page: 1 });
  };

  const clearFilters = () => {
    setSearchInput("");
    void navigate("/bookmarks");
  };

  const toggleView = (newView: "grid" | "table") => {
    setView(newView);
    navigateTo({ view: newView, page: 1 });
  };

  const handleOpenUrl = (url: string) => {
    navigateToExternalUrl(url, {
      newTab: true,
      onInvalid: () => {
        showError(t("bookmarks.navigation.unsafe_url"));
      },
    });
  };

  const toggleBulkSelectMode = () => {
    setBulkSelectMode((prev) => {
      if (prev) {
        // Exiting bulk-select mode clears selection
        setSelectedIds(new Set());
      }
      return !prev;
    });
  };

  // Escape key exits bulk-select mode
  useEffect(() => {
    if (!bulkSelectMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        toggleBulkSelectMode();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bulkSelectMode]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === data.items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.items.map((b) => b.id)));
    }
  };

  const handlePin = async (id: string, pinned: boolean) => {
    try {
      const { toggleBookmarkPin } = await import("./bookmarks-api.js");
      await toggleBookmarkPin(id, pinned);
      void navigate(buildUrl({}), { replace: true });
    } catch {
      // silently fail - UX toast system not yet available at this scope
    }
  };

  const handleBulkPin = async (pinned: boolean) => {
    const ids = [...selectedIds];
    try {
      await bulkPinBookmarks(ids, pinned);
      setSelectedIds(new Set());
      void navigate(buildUrl({}), { replace: true });
    } catch {
      // ignore
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    try {
      await bulkDeleteBookmarks(ids);
      setSelectedIds(new Set());
      void navigate(buildUrl({}), { replace: true });
    } catch {
      // ignore
    }
  };

  const handleBulkMoveToFolder = async (folderId: string) => {
    const ids = [...selectedIds];
    try {
      await bulkMoveToFolder(ids, folderId);
      setSelectedIds(new Set());
      void navigate(buildUrl({}), { replace: true });
    } catch {
      // ignore
    }
  };

  const handleBulkAddTags = async (tagIds: string[]) => {
    const ids = [...selectedIds];
    try {
      await bulkAddTags(ids, tagIds);
      setSelectedIds(new Set());
      showToast("bookmarks.list.bulk_tags_toast_success");
      void navigate(buildUrl({}), { replace: true });
    } catch {
      showError(t("bookmarks.list.bulk_tags_error"));
    }
  };

  const handleBulkRemoveTags = async (tagIds: string[]) => {
    const ids = [...selectedIds];
    try {
      await bulkRemoveTags(ids, tagIds);
      setSelectedIds(new Set());
      showToast("bookmarks.list.bulk_tags_toast_success");
      void navigate(buildUrl({}), { replace: true });
    } catch {
      showError(t("bookmarks.list.bulk_tags_error"));
    }
  };

  // Single-item edit: open the BookmarkModal pre-filled with the bookmark data
  const handleEditBookmark = useCallback(
    (item: BookmarkListItem) => {
      openEdit({
        id: item.id,
        title: item.title,
        url: item.url,
        slug: item.slug,
        forwardingEnabled: item.forwardingEnabled,
        pinned: item.pinned,
        folderIds: item.folders.map((f) => f.id),
        tagIds: item.tags.map((t) => t.id),
      });
    },
    [openEdit],
  );

  // Single-item delete: open confirmation dialog
  const [deleteTarget, setDeleteTarget] = useState<BookmarkListItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteBookmark(deleteTarget.id);
      setDeleteTarget(null);
      showToast("bookmarks.list.toast_deleted");
      void navigate(buildUrl({}), { replace: true });
    } catch {
      showError(t("bookmarks.list.error_delete"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const activeFolder = toolbarOptions.folders.find((f) => f.id === data.folderId);
  const activeSortLabel = SORT_OPTIONS.find((s) => s.id === data.sort);

  // Toolbar folders (use server-side toolbarFolders as fallback until client loads)
  const folders =
    toolbarOptions.folders.length > 0
      ? toolbarOptions.folders
      : data.toolbarFolders.map((f) => ({ id: f.id, name: f.name }));

  const tags =
    toolbarOptions.tags.length > 0
      ? toolbarOptions.tags
      : data.toolbarTags.map((t) => ({ id: t.id, name: t.name }));

  if (isLoading) {
    return <BookmarkListSkeleton />;
  }

  const allSelected =
    data.items.length > 0 && selectedIds.size === data.items.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const hasSelection = selectedIds.size > 0;
  const pinnedItems = data.items.filter((b) => b.pinned);
  const nonPinnedItems = data.items.filter((b) => !b.pinned);
  const showPinnedSection =
    data.page === 1 && pinnedItems.length > 0 && !data.pinnedOnly;

  return (
    <div className="flex w-full flex-col" data-testid="bookmark-list-page">
      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center gap-sp-3 border-b border-[color:var(--border-subtle)] px-sp-7 py-sp-2"
        data-testid="bookmark-list-toolbar"
      >
        {/* Search */}
        <div className="flex min-w-[12rem] flex-1 items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3">
          <svg aria-hidden viewBox="0 0 14 14" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <circle cx="6" cy="6" r="4.5" />
            <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" />
          </svg>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => {
              handleSearch(e.target.value);
            }}
            placeholder={t("bookmarks.list.search_placeholder")}
            className="min-w-0 flex-1 bg-transparent text-small text-fg placeholder:text-fg-faint focus:outline-none"
            data-testid="bookmark-list-search"
          />
        </div>

        {/* Folder filter */}
        {folders.length > 0 ? (
          <ChipDropdown
            label={
              activeFolder ? (
                <span className="flex items-center gap-sp-2">
                  <FolderIcon />
                  {activeFolder.name}
                </span>
              ) : (
                <span className="flex items-center gap-sp-2">
                  <FolderIcon />
                  {t("bookmarks.list.filter_folder")}
                </span>
              )
            }
            active={!!data.folderId}
            width={210}
            testId="bookmark-folder-filter"
          >
            <MenuHead>{t("bookmarks.list.filter_folder_heading")}</MenuHead>
            <MenuItem
              checked={!data.folderId}
              onClick={() => {
                navigateTo({ folderId: null, page: 1 });
              }}
            >
              {t("bookmarks.list.filter_folder_all")}
            </MenuItem>
            {folders.map((folder) => (
              <MenuItem
                key={folder.id}
                checked={data.folderId === folder.id}
                onClick={() => {
                  navigateTo({ folderId: folder.id, page: 1 });
                }}
              >
                {folder.name}
              </MenuItem>
            ))}
          </ChipDropdown>
        ) : null}

        {/* Tags filter */}
        {tags.length > 0 ? (
          <ChipDropdown
            label={
              <span className="flex items-center gap-sp-2">
                <HashIcon />
                {data.tagIds.length > 0
                  ? t("bookmarks.list.filter_tags_active", {
                      count: data.tagIds.length,
                    })
                  : t("bookmarks.list.filter_tags")}
              </span>
            }
            active={data.tagIds.length > 0}
            width={200}
            testId="bookmark-tags-filter"
          >
            <MenuHead>{t("bookmarks.list.filter_tags_heading")}</MenuHead>
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
              {tags.map((tag) => {
                const isActive = data.tagIds.includes(tag.id);
                const newTagIds = isActive
                  ? data.tagIds.filter((id) => id !== tag.id)
                  : [...data.tagIds, tag.id];
                return (
                  <MenuItem
                    key={tag.id}
                    icon={
                      <span
                        className={[
                          "grid h-4 w-4 place-items-center rounded-sm border transition-colors",
                          isActive
                            ? "border-[color:var(--accent-border)] bg-accent text-accent-fg"
                            : "border-[color:var(--border-subtle)] bg-canvas",
                        ].join(" ")}
                      >
                        {isActive ? <CheckIcon /> : null}
                      </span>
                    }
                    onClick={() => {
                      navigateTo({ tagIds: newTagIds, page: 1 });
                    }}
                  >
                    <span className="font-mono" style={{ fontSize: 12 }}>
                      #{tag.name}
                    </span>
                  </MenuItem>
                );
              })}
            </div>
          </ChipDropdown>
        ) : null}

        {/* Pinned toggle */}
        <button
          type="button"
          className={[
            "inline-flex items-center gap-sp-3 rounded-md border px-sp-4 py-sp-3 text-small",
            data.pinnedOnly
              ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-accent-text"
              : "border-[color:var(--border)] bg-[color:var(--raised)] text-fg-muted hover:text-fg",
          ].join(" ")}
          onClick={() => {
            navigateTo({ pinned: !data.pinnedOnly, page: 1 });
          }}
          data-testid="bookmark-pinned-filter"
        >
          <PinIcon filled={data.pinnedOnly} />
          {t("bookmarks.list.filter_pinned")}
        </button>

        {/* Scope filter */}
        {canShare ? (
          <ScopeFilter value={data.scope} onChange={handleScopeChange} />
        ) : null}

        {/* Clear filters */}
        {hasFilters ? (
          <button
            type="button"
            className="inline-flex items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3 text-small text-danger-text hover:bg-[color:var(--danger-subtle)]"
            onClick={clearFilters}
            data-testid="bookmark-clear-filters"
          >
            <XIcon />
            {t("bookmarks.list.clear_filters_action")}
          </button>
        ) : null}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Import */}
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setImportOpen(true);
          }}
          data-testid="bookmark-import-action"
        >
          {t("bookmarks.list.import_action")}
        </Button>

        {/* Result count */}
        <span
          className="font-mono text-small text-fg-subtle"
          data-testid="bookmark-result-count"
        >
          {t("bookmarks.list.result_count", { count: data.total })}
        </span>

        {/* Bulk select toggle */}
        <button
          type="button"
          className={[
            "inline-flex items-center gap-sp-3 rounded-md border px-sp-4 py-sp-3 text-small",
            bulkSelectMode
              ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-accent-text"
              : "border-[color:var(--border)] bg-[color:var(--raised)] text-fg-muted hover:text-fg",
          ].join(" ")}
          onClick={toggleBulkSelectMode}
          data-testid="bookmark-bulk-select-toggle"
        >
          {t(bulkSelectMode ? "bookmarks.list.select_active" : "bookmarks.list.select_action")}
        </button>

        {/* Sort dropdown */}
        <ChipDropdown
          label={
            <span className="flex items-center gap-sp-2">
              <SortIcon />
              {activeSortLabel ? t(activeSortLabel.labelKey) : t("bookmarks.list.sort_recent")}
            </span>
          }
          align="right"
          width={200}
          testId="bookmark-sort"
        >
          <MenuHead>{t("bookmarks.list.sort_heading")}</MenuHead>
          {SORT_OPTIONS.map((s) => (
            <MenuItem
              key={s.id}
              checked={data.sort === s.id}
              onClick={() => {
                navigateTo({ sort: s.id, page: 1 });
              }}
            >
              {t(s.labelKey)}
            </MenuItem>
          ))}
        </ChipDropdown>

        {/* View toggle */}
        <div
          className="flex overflow-hidden rounded-md border border-[color:var(--border)]"
          role="group"
          aria-label={t("bookmarks.list.view_toggle_label")}
        >
          <button
            type="button"
            className={[
              "px-sp-3 py-sp-3 text-small transition-colors duration-micro",
              view === "grid"
                ? "bg-accent text-accent-fg"
                : "bg-raised text-fg-muted hover:text-fg",
            ].join(" ")}
            onClick={() => {
              toggleView("grid");
            }}
            aria-pressed={view === "grid"}
            title={t("bookmarks.list.view_grid")}
          >
            <GridIcon />
          </button>
          <button
            type="button"
            className={[
              "px-sp-3 py-sp-3 text-small transition-colors duration-micro",
              view === "table"
                ? "bg-accent text-accent-fg"
                : "bg-raised text-fg-muted hover:text-fg",
            ].join(" ")}
            onClick={() => {
              toggleView("table");
            }}
            aria-pressed={view === "table"}
            title={t("bookmarks.list.view_table")}
          >
            <ListIcon />
          </button>
        </div>
      </div>

      {/* Cap banner (between toolbar and content) */}
      {data.bookmarkCap !== null ? (
        <div className="px-sp-7 pt-sp-6">
          <BookmarkCapBanner
            total={data.workspaceBookmarkTotal}
            cap={data.bookmarkCap}
          />
        </div>
      ) : null}

      {/* Content */}
      {data.items.length === 0 ? (
        <div className="p-sp-7" data-testid="bookmark-list-empty">
          {hasFilters ? (
            <EmptyState
              title={t("bookmarks.list.empty_title")}
              description={t("bookmarks.list.empty_body")}
              actions={
                <Button variant="secondary" type="button" onClick={clearFilters}>
                  {t("bookmarks.list.clear_filters_action")}
                </Button>
              }
              testId="bookmark-list-empty-filtered"
            />
          ) : (
            <EmptyState
              illustration={
                <img
                  src="/slugbase_icon.svg"
                  alt=""
                  width={80}
                  height={80}
                  className="opacity-30"
                />
              }
              title={t("bookmarks.list.empty_unfiltered_title")}
              description={t("bookmarks.list.empty_unfiltered_body")}
              actions={
                <div className="flex items-center gap-sp-4">
                  <Button
                    variant="primary"
                    type="button"
                    onClick={() => {
                      openCreate();
                    }}
                  >
                    {t("bookmarks.list.new_bookmark_action")}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setImportOpen(true);
                    }}
                    data-testid="bookmark-import-action-empty"
                  >
                    {t("bookmarks.list.import_action")}
                  </Button>
                </div>
              }
              testId="bookmark-list-empty-unfiltered"
            />
          )}
        </div>
      ) : view === "grid" ? (
        <div className="p-sp-7" data-testid="bookmark-grid">
          {showPinnedSection ? (
            <>
              <SectionHead
                icon={<PinIcon filled />}
                label={t("bookmarks.list.section_pinned")}
                count={pinnedItems.length}
                testId="bookmark-section-pinned"
              />
              <div
                className="grid gap-sp-5"
                style={{
                  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                }}
              >
                {pinnedItems.map((bookmark) => (
                  <BookmarkCard
                    key={bookmark.id}
                    bookmark={bookmark}
                    selected={selectedIds.has(bookmark.id)}
                    bulkSelectMode={bulkSelectMode}
                    onToggleSelect={() => {
                      toggleSelect(bookmark.id);
                    }}
                    onOpenUrl={handleOpenUrl}
                    onPin={(pinned) => {
                      void handlePin(bookmark.id, pinned);
                    }}
                    onEdit={handleEditBookmark}
                    onDelete={(item) => {
                      setDeleteTarget(item);
                    }}
                    currentUserId={currentUserId}
                  />
                ))}
              </div>
              {nonPinnedItems.length > 0 ? (
                <>
                  <SectionHead
                    label={t("bookmarks.list.section_all_bookmarks")}
                    testId="bookmark-section-all"
                  />
                  <div
                    className="grid gap-sp-5"
                    style={{
                      gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                    }}
                  >
                    {nonPinnedItems.map((bookmark) => (
                      <BookmarkCard
                        key={bookmark.id}
                        bookmark={bookmark}
                        selected={selectedIds.has(bookmark.id)}
                        bulkSelectMode={bulkSelectMode}
                        onToggleSelect={() => {
                          toggleSelect(bookmark.id);
                        }}
                        onOpenUrl={handleOpenUrl}
                        onPin={(pinned) => {
                          void handlePin(bookmark.id, pinned);
                        }}
                        onEdit={handleEditBookmark}
                        onDelete={(item) => {
                          setDeleteTarget(item);
                        }}
                        currentUserId={currentUserId}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div
              className="grid gap-sp-5"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              }}
            >
              {data.items.map((bookmark) => (
                <BookmarkCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  selected={selectedIds.has(bookmark.id)}
                  bulkSelectMode={bulkSelectMode}
                  onToggleSelect={() => {
                    toggleSelect(bookmark.id);
                  }}
                  onOpenUrl={handleOpenUrl}
                  onPin={(pinned) => {
                    void handlePin(bookmark.id, pinned);
                  }}
                  onEdit={handleEditBookmark}
                  onDelete={(item) => {
                    setDeleteTarget(item);
                  }}
                  currentUserId={currentUserId}
                />
              ))}
            </div>
          )}
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={(p) => {
              navigateTo({ page: p });
            }}
          />
        </div>
      ) : (
        <div className="p-sp-7" data-testid="bookmark-table">
          <div className="overflow-hidden rounded-none">
          <TableHead
            sort={data.sort}
            setSort={(sort) => {
              navigateTo({ sort, page: 1 });
            }}
            bulkSelectMode={bulkSelectMode}
            allSelected={allSelected}
            someSelected={someSelected}
            onToggleAll={toggleAll}
          />
          {data.items.map((bookmark) => (
            <BookmarkRow
              key={bookmark.id}
              bookmark={bookmark}
              selected={selectedIds.has(bookmark.id)}
              bulkSelectMode={bulkSelectMode}
              onToggleSelect={() => {
                toggleSelect(bookmark.id);
              }}
              onOpenUrl={handleOpenUrl}
              onPin={(pinned) => {
                void handlePin(bookmark.id, pinned);
              }}
              onEdit={handleEditBookmark}
              onDelete={(item) => {
                setDeleteTarget(item);
              }}
              currentUserId={currentUserId}
              sort={data.sort}
            />
          ))}
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={(p) => {
              navigateTo({ page: p });
            }}
          />
          </div>
        </div>
      )}

      {/* Bulk bar */}
      {hasSelection ? (
        <BulkBar
          count={selectedIds.size}
          onClear={() => {
            setSelectedIds(new Set());
          }}
          onPin={() => {
            void handleBulkPin(true);
          }}
          onUnpin={() => {
            void handleBulkPin(false);
          }}
          onDelete={() => {
            void handleBulkDelete();
          }}
          onMoveToFolder={(folderId) => {
            void handleBulkMoveToFolder(folderId);
          }}
          onBulkAddTags={(tagIds) => {
            void handleBulkAddTags(tagIds);
          }}
          onBulkRemoveTags={(tagIds) => {
            void handleBulkRemoveTags(tagIds);
          }}
          folders={data.toolbarFolders}
          tags={tags}
        />
      ) : null}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("bookmarks.list.delete_title")}
        body={
          <p className="text-fg-muted">
            {t("bookmarks.list.delete_body", {
              title: deleteTarget?.title ?? "",
            })}
          </p>
        }
        confirmLabel={t("bookmarks.list.delete_confirm")}
        cancelLabel={t("bookmarks.list.delete_cancel")}
        onConfirm={() => {
          void handleDeleteConfirm();
        }}
        destructive
        busy={deleteBusy}
        testId="bookmark-delete-dialog"
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={handleImportSuccess}
        atCap={atBookmarkCap}
      />
    </div>
  );
}