import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ExternalLinkIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import { ScopeIcon } from "../sharing/ScopeIcon.js";
import { resolveResourceSharingScope } from "../sharing/sharing.utils.js";
import type { BookmarkListItem } from "../../routes/bookmarks/bookmarks-loader.js";
import { BookmarkFavicon } from "../../routes/bookmarks/BookmarkFavicon.js";

export interface BookmarkCardProps {
  bookmark: BookmarkListItem;
  selected: boolean;
  bulkSelectMode: boolean;
  onToggleSelect: () => void;
  onOpenUrl: (url: string) => void;
  onPin: (pinned: boolean) => void;
  onEdit: (bookmark: BookmarkListItem) => void;
  onDelete: (bookmark: BookmarkListItem) => void;
  currentUserId: string | null;
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

function tagChipStyle(color: string | null | undefined): CSSProperties {
  if (!color) return { fontSize: 11 };
  return {
    fontSize: 11,
    backgroundColor: `color-mix(in srgb, ${color} 14%, var(--raised-2))`,
    borderColor: `color-mix(in srgb, ${color} 38%, var(--border-subtle))`,
    color,
  };
}

function TagChip({ name, color }: { name: string; color?: string | null }) {
  return (
    <span
      className={
        color
          ? "inline-flex items-center gap-sp-1 rounded border px-sp-3 py-sp-1 font-mono"
          : "inline-flex items-center gap-sp-1 rounded border border-[color:var(--border-subtle)] bg-[color:var(--raised-2)] px-sp-3 py-sp-1 font-mono text-fg-subtle"
      }
      style={tagChipStyle(color)}
    >
      <HashIcon />
      {name}
    </span>
  );
}

function FolderChip({ name, color }: { name: string; color?: string | null }) {
  return (
    <span
      className={
        color
          ? "inline-flex items-center gap-sp-1 rounded border px-sp-3 py-sp-1 font-mono"
          : "inline-flex items-center gap-sp-1 rounded border border-[color:var(--border-subtle)] bg-[color:var(--raised-2)] px-sp-3 py-sp-1 font-mono text-fg-subtle"
      }
      style={tagChipStyle(color)}
    >
      <FolderIcon />
      {name}
    </span>
  );
}

export function BookmarkCard({
  bookmark,
  selected,
  bulkSelectMode,
  onToggleSelect,
  onOpenUrl,
  onPin,
  onEdit,
  onDelete,
  currentUserId,
}: BookmarkCardProps) {
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

      <div className="flex min-w-0 items-center gap-sp-2 text-fg-subtle">
        <GlobeIcon />
        <span
          className="flex-1 truncate"
          style={{ fontSize: "var(--text-small)" }}
        >
          {bookmark.url}
        </span>
      </div>

      {bookmark.slug ? (
        <span
          className="inline-flex items-center gap-sp-2 self-start rounded border border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] px-sp-3 py-sp-1 font-mono text-accent-text"
          style={{ fontSize: 12 }}
        >
          <LinkIcon size={12} />
          /{bookmark.slug}
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

      <div className="flex flex-wrap items-center gap-sp-3">
        {bookmark.folders.length > 0 ? (
          <FolderChip
            name={bookmark.folders[0]?.name ?? ""}
            color={bookmark.folders[0]?.color}
          />
        ) : null}
        {bookmark.tags.slice(0, 2).map((tag) => (
          <TagChip key={tag.id} name={tag.name} color={tag.color} />
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
