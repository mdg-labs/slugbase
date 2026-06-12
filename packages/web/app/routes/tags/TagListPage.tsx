import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigate, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { CheckIcon, ExternalLinkIcon, HashIcon, LinkIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button, ConfirmDialog, Dialog, DialogContent, EmptyState } from "@slugbase/ui";
import { useAppToast } from "../../components/feedback/AppToastProvider.js";
import { BookmarkFavicon } from "../bookmarks/BookmarkFavicon.js";
import { type TagListData, type TagListItem } from "./tags-loader.js";
import { TagListSkeleton } from "./TagListSkeleton.js";
import { createTag, renameTag, deleteTag, fetchTaggedBookmarks } from "./tags-api.js";
import type { TaggedBookmark } from "./tags-api.js";

const SORTS = ["usage-desc", "name-asc", "created-desc"] as const;
type TagSort = (typeof SORTS)[number];

function isTagSort(value: string): value is TagSort {
  return (SORTS as readonly string[]).includes(value);
}

const SORT_OPTIONS: { value: TagSort; labelKey: string }[] = [
  { value: "usage-desc", labelKey: "tags.list.sort_most_used" },
  { value: "name-asc", labelKey: "tags.list.sort_alpha" },
  { value: "created-desc", labelKey: "tags.list.sort_recent" },
];

const PRESET_COLORS = [
  "#7782f7",
  "#45c98a",
  "#e6b24e",
  "#f0686b",
  "#5ba4e6",
  "#e8944a",
  "#a77bea",
  "#8a90a0",
];

function ColorDot({ color, size = 8 }: { color: string | null; size?: number }) {
  if (!color) return null;
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

/* ---------- Color picker ---------- */

interface ColorPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
}

function ColorPicker({ value, onChange }: ColorPickerProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-sp-2">
      <label
        className="text-fg-muted"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {t("tags.modal.color_label")}
      </label>
      <div className="flex items-center gap-sp-3">
        {PRESET_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="relative h-7 w-7 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] focus:ring-offset-2 focus:ring-offset-[color:var(--overlay)]"
            style={{ backgroundColor: swatch }}
            aria-label={swatch}
            onClick={() => { onChange(value === swatch ? null : swatch); }}
          >
            {value === swatch && (
              <CheckIcon size={14} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white" />
            )}
          </button>
        ))}
        {value && (
          <button
            type="button"
            className="text-fg-muted transition-colors hover:text-fg"
            style={{ fontSize: "var(--text-small)" }}
            onClick={() => { onChange(null); }}
          >
            {t("tags.modal.color_none")}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Usage bar ---------- */

interface UsageBarProps {
  count: number;
  max: number;
}

function UsageBar({ count, max }: UsageBarProps) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div
      className="h-[5px] w-full overflow-hidden rounded-full bg-[color:var(--border)]"
      role="meter"
      aria-valuenow={count}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        className="h-full rounded-full bg-[color:var(--accent)]"
        style={{ width: `${String(pct)}%` }}
      />
    </div>
  );
}

/* ---------- Tag row ---------- */

interface TagRowProps {
  tag: TagListItem;
  maxCount: number;
  isSelected: boolean;
  onSelect: (tag: TagListItem) => void;
  onRenameRequest: (tag: TagListItem) => void;
  onDeleteRequest: (tag: TagListItem) => void;
}

function TagRow({
  tag,
  maxCount,
  isSelected,
  onSelect,
  onRenameRequest,
  onDeleteRequest,
}: TagRowProps) {
  const { t } = useTranslation();
  return (
    <div>
      <div
        className={[
          "group grid cursor-pointer items-center gap-sp-4 rounded-md px-sp-4 py-sp-3 transition-colors",
          "hover:bg-[color:var(--raised-2)]",
          isSelected ? "bg-[color:var(--raised-2)] ring-1 ring-[color:var(--accent)]" : "",
        ].join(" ")}
        style={{ gridTemplateColumns: "1fr 180px 80px 80px" }}
        onClick={() => { onSelect(tag); }}
        data-testid={`tag-row-${tag.id}`}
      >
        <div className="flex min-w-0 items-center gap-sp-2">
          <ColorDot color={tag.color} />
          <span
            className="truncate text-fg"
            style={{ fontSize: "var(--text-body)", fontFamily: "var(--font-mono)" }}
          >
            #{tag.name}
          </span>
        </div>

        <div className="flex items-center">
          <UsageBar count={tag.bookmarkCount} max={maxCount} />
        </div>

        <div
          className="text-center text-fg-muted"
          style={{ fontSize: "var(--text-small)", fontFamily: "var(--font-mono)" }}
        >
          {tag.bookmarkCount}
        </div>

        <div
          className="flex items-center justify-end gap-sp-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          onClick={(e) => { e.stopPropagation(); }}
        >
          <button
            type="button"
            title={t("tags.list.action_rename")}
            aria-label={t("tags.list.action_rename")}
            className="inline-flex items-center justify-center rounded p-sp-1 text-fg-muted transition-colors hover:bg-[color:var(--overlay)] hover:text-fg"
            onClick={() => { onRenameRequest(tag); }}
          >
            <PencilIcon size={14} />
          </button>
          <button
            type="button"
            title={t("tags.list.action_delete")}
            aria-label={t("tags.list.action_delete")}
            className="inline-flex items-center justify-center rounded p-sp-1 text-[color:var(--danger-text)] transition-colors hover:bg-[color:var(--overlay)]"
            onClick={() => { onDeleteRequest(tag); }}
          >
            <Trash2Icon size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Tag detail panel ---------- */

interface TagDetailPanelProps {
  tag: TagListItem;
  onClose: () => void;
  onRenameRequest: (tag: TagListItem) => void;
  onDeleteRequest: (tag: TagListItem) => void;
}

function TagDetailPanel({ tag, onClose, onRenameRequest, onDeleteRequest }: TagDetailPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [bookmarks, setBookmarks] = useState<TaggedBookmark[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBookmarks(null);
    setLoading(true);
    void fetchTaggedBookmarks(tag.id)
      .then((items) => {
        if (!cancelled) {
          setBookmarks(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBookmarks([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [tag.id]);

  return (
    <div className="flex h-full flex-col border-l border-[color:var(--border)] bg-[color:var(--base)]" data-testid="tag-detail-panel">
      <div className="border-b border-[color:var(--border)] p-sp-5">
        <div className="mb-sp-3 flex items-center justify-between">
          <div className="flex items-center gap-sp-2">
            <ColorDot color={tag.color} size={10} />
            <span
              className="truncate font-semibold text-fg"
              style={{ fontSize: "var(--text-h3)", fontFamily: "var(--font-mono)" }}
            >
              #{tag.name}
            </span>
          </div>
          <button
            type="button"
            title={t("tags.detail.close")}
            aria-label={t("tags.detail.close")}
            className="ml-sp-3 shrink-0 inline-flex items-center justify-center rounded p-sp-2 text-fg-muted transition-colors hover:bg-[color:var(--raised-2)] hover:text-fg"
            onClick={onClose}
          >
            <XIcon size={15} />
          </button>
        </div>
        <div className="flex gap-sp-5 text-fg-muted" style={{ fontSize: "var(--text-small)" }}>
          <span>
            <b className="font-semibold text-fg" style={{ fontFamily: "var(--font-mono)" }}>
              {tag.bookmarkCount}
            </b>{" "}
            {t("tags.detail.bookmark_count", { count: tag.bookmarkCount })}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-sp-5" data-testid="tags-detail-body">
        {loading ? (
          <div className="flex items-center justify-center py-sp-8">
            <span className="text-fg-subtle" style={{ fontSize: "var(--text-small)" }}>
              {t("tags.detail.loading")}
            </span>
          </div>
        ) : bookmarks === null || bookmarks.length === 0 ? (
          <div className="flex flex-col items-center gap-sp-4 py-sp-8 text-center">
            <HashIcon size={28} strokeWidth={1.25} className="text-fg-faint" />
            <p className="text-fg-muted" style={{ fontSize: "var(--text-body)" }}>
              {t("tags.detail.empty_body", { name: tag.name })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-sp-1">
            {bookmarks.map((bm) => (
              <div
                key={bm.id}
                className="tag-bm-item flex cursor-pointer items-start gap-sp-3 rounded-md px-sp-3 py-sp-3 transition-colors hover:bg-[color:var(--raised-2)]"
                onClick={() => { void navigate(`/bookmarks?tagId=${tag.id}`); }}
                data-testid={`tag-bm-item-${bm.id}`}
              >
                <BookmarkFavicon url={bm.url} size={24} className="mt-sp-1" />
                <div className="tag-bm-info min-w-0 flex-1">
                  <div
                    className="tag-bm-title truncate font-medium text-fg"
                    style={{ fontSize: "var(--text-body)" }}
                  >
                    {bm.title}
                  </div>
                  <div
                    className="tag-bm-url truncate text-fg-subtle"
                    style={{ fontSize: "var(--text-small)" }}
                  >
                    {bm.url}
                  </div>
                </div>
                {bm.slug && (
                  <span
                    className="slug-line mt-sp-1 flex shrink-0 items-center gap-sp-1 text-fg-faint"
                    style={{ fontSize: 11 }}
                  >
                    <LinkIcon size={11} />
                    <span className="addr">/go/{bm.slug}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-sp-3 border-t border-[color:var(--border)] p-sp-5">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => { void navigate(`/bookmarks?tagId=${tag.id}`); }}
        >
          <ExternalLinkIcon size={14} className="shrink-0" />
          {t("tags.detail.view_all_bookmarks")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => { onRenameRequest(tag); }}
        >
          <PencilIcon size={14} className="shrink-0" />
          {t("tags.detail.rename")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="text-[color:var(--danger-text)]"
          onClick={() => { onDeleteRequest(tag); }}
        >
          <Trash2Icon size={14} className="shrink-0" />
          {t("tags.detail.delete")}
        </Button>
      </div>
    </div>
  );
}

/* ---------- Tag modal (create / rename) ---------- */

interface TagModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initialName?: string;
  initialColor?: string | null;
  onSubmit: (name: string, color: string | null) => Promise<void>;
}

function TagModal({ open, onOpenChange, mode, initialName = "", initialColor = null, onSubmit }: TagModalProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<string | null>(initialColor);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setColor(initialColor);
      setSubmitting(false);
      setTimeout(() => { inputRef.current?.focus(); }, 50);
    }
  }, [open, initialName, initialColor]);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, color);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const titleKey = mode === "create" ? "tags.modal.create_title" : "tags.modal.edit_title";
  const submitKey = mode === "create" ? "tags.modal.submit_create" : "tags.modal.submit_edit";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t(titleKey)} testId="tag-modal">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => { void handleSubmit(e); }}
          noValidate
        >
          <div className="flex min-h-0 flex-1 flex-col gap-sp-6 overflow-y-auto px-sp-8 py-sp-6">
            <div className="flex flex-col gap-sp-2">
              <label
                htmlFor="tag-name-input"
                className="text-fg-muted"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
              >
                {t("tags.modal.name_label")}
              </label>
              <input
                ref={inputRef}
                id="tag-name-input"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setName(e.target.value); }}
                placeholder={t("tags.modal.name_placeholder")}
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3 text-fg outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
                style={{ fontSize: "var(--text-body)", fontFamily: "var(--font-mono)" }}
                maxLength={200}
                required
              />
            </div>

            <ColorPicker value={color} onChange={setColor} />
          </div>

          <div className="flex items-center justify-end gap-sp-4 border-t border-[color:var(--border-subtle)] px-sp-8 py-sp-5">
            <Button type="button" variant="ghost" disabled={submitting} onClick={() => { onOpenChange(false); }}>
              {t("tags.modal.cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {t(submitKey)}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- Main page ---------- */

export function TagListPage() {
  const { t } = useTranslation();
  const data = useLoaderData<TagListData>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const { showToast, showError } = useAppToast();

  const [selected, setSelected] = useState<TagListItem | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editTarget, setEditTarget] = useState<TagListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagListItem | null>(null);

  const isLoading = navigation.state === "loading";
  const currentSort = isTagSort(data.sort) ? data.sort : "usage-desc";
  const currentSortLabel = SORT_OPTIONS.find((s) => s.value === currentSort)?.labelKey ?? "tags.list.sort_most_used";

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); };
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    };
    if (sortOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [sortOpen]);

  const updateSort = (sort: TagSort) => {
    const next = new URLSearchParams(searchParams);
    next.set("sort", sort);
    next.delete("page");
    void navigate(`/tags?${next.toString()}`);
    setSortOpen(false);
  };

  const handleCreateSubmit = async (name: string, color: string | null) => {
    try {
      await createTag(name, color);
      showToast("tags.list.toast_created");
      void revalidator.revalidate();
    } catch {
      showError(t("tags.list.error_create"));
    }
  };

  const handleEditSubmit = async (name: string, color: string | null) => {
    if (!editTarget) return;
    try {
      await renameTag(editTarget.id, name, color);
      if (selected?.id === editTarget.id) {
        setSelected({ ...selected, name, color });
      }
      showToast("tags.list.toast_renamed");
      void revalidator.revalidate();
    } catch {
      showError(t("tags.list.error_rename"));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await deleteTag(deleteTarget.id);
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
      showToast("tags.list.toast_deleted");
      void revalidator.revalidate();
    } catch {
      showError(t("tags.list.error_delete"));
    }
  };

  if (isLoading) {
    return <TagListSkeleton hasPanel={!!selected} />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className="flex min-h-0 flex-1"
        style={{ gridTemplateColumns: selected ? "1fr 360px" : "1fr", display: selected ? "grid" : "flex" }}
      >
        {/* Left panel: tag list */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-sp-3 border-b border-[color:var(--border)] px-sp-7 py-sp-2" data-testid="tag-list-toolbar">
              <div className="flex w-[220px] items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-3">
                <SearchIcon size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
                <input
                  value={data.q}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const next = new URLSearchParams(searchParams.toString());
                    if (e.target.value) {
                      next.set("q", e.target.value);
                    } else {
                      next.delete("q");
                    }
                    next.delete("page");
                    void navigate(`/tags?${next.toString()}`);
                  }}
                  placeholder={t("tags.list.search_placeholder")}
                  className="flex-1 bg-transparent py-sp-3 text-fg outline-none placeholder:text-fg-muted"
                  style={{ fontSize: "var(--text-body)" }}
                  data-testid="tag-list-search"
                />
                {data.q && (
                  <button
                    type="button"
                    aria-label={t("bookmarks.list.clear_filters_action")}
                    className="shrink-0 text-fg-faint hover:text-fg"
                    onClick={() => {
                      const next = new URLSearchParams(searchParams);
                      next.delete("q");
                      void navigate(`/tags?${next.toString()}`);
                    }}
                  >
                    <XIcon size={14} />
                  </button>
                )}
              </div>

              <div className="flex-1" />

              <span
                className="shrink-0 text-fg-subtle"
                style={{ fontSize: "var(--text-small)", fontFamily: "var(--font-mono)" }}
              >
                {t("tags.list.subtitle", { count: data.items.length })}
              </span>

              <div className="relative" ref={sortRef}>
                <button
                  type="button"
                  className="flex items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-3 py-sp-2 text-fg-muted transition-colors hover:bg-[color:var(--raised)]"
                  style={{ fontSize: "var(--text-small)" }}
                  aria-expanded={sortOpen}
                  onClick={() => { setSortOpen((o) => !o); }}
                >
                  {t(currentSortLabel)}
                </button>
                {sortOpen && (
                  <div className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[190px] overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-2 shadow-lg">
                    <p
                      className="mb-sp-1 px-sp-3 text-fg-subtle"
                      style={{ fontSize: "var(--text-small)" }}
                    >
                      {t("tags.list.sort_heading")}
                    </p>
                    {SORT_OPTIONS.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className="flex w-full items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-left text-fg transition-colors hover:bg-[color:var(--raised-2)]"
                        style={{ fontSize: "var(--text-body)" }}
                        onClick={() => { updateSort(s.value); }}
                      >
                        {currentSort === s.value && (
                          <CheckIcon size={12} className="text-[color:var(--accent)]" aria-hidden="true" />
                        )}
                        <span className={currentSort === s.value ? "font-medium" : ""}>{t(s.labelKey)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => { setShowCreateModal(true); }}
                data-testid="tag-list-new-btn"
              >
                <PlusIcon size={15} className="shrink-0" />
                {t("tags.list.new_action")}
              </Button>
            </div>

          <div className="flex-1 overflow-y-auto p-sp-7">
            {data.items.length === 0 ? (
              <EmptyState
                illustration={<HashIcon size={36} strokeWidth={1.25} />}
                title={
                  data.q
                    ? t("tags.list.empty_search_title", { q: data.q })
                    : t("tags.list.empty_title")
                }
                description={
                  data.q
                    ? undefined
                    : t("tags.list.empty_body")
                }
                actions={
                  data.q ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => { void navigate("/tags"); }}
                    >
                      <XIcon size={13} className="shrink-0" />
                      {t("tags.list.clear_search")}
                    </Button>
                  ) : undefined
                }
                testId="tag-list-empty-state"
              />
            ) : (
              <div data-testid="tag-list">
                {/* Table header */}
                {data.items.length > 0 && (
                  <div
                    className="mb-sp-1 grid px-sp-4 text-fg-subtle"
                    style={{
                      gridTemplateColumns: "1fr 180px 80px 80px",
                      fontSize: "var(--text-small)",
                    }}
                  >
                    <button
                      type="button"
                      className={[
                        "flex items-center gap-sp-1 text-left transition-colors hover:text-fg",
                        currentSort === "name-asc" ? "font-medium text-fg" : "",
                      ].join(" ")}
                      onClick={() => { updateSort("name-asc"); }}
                    >
                      {t("tags.list.col_tag")}
                    </button>
                    <button
                      type="button"
                      className={[
                        "flex items-center gap-sp-1 text-left transition-colors hover:text-fg",
                        currentSort === "usage-desc" ? "font-medium text-fg" : "",
                      ].join(" ")}
                      onClick={() => { updateSort("usage-desc"); }}
                    >
                      {t("tags.list.col_usage")}
                    </button>
                    <button
                      type="button"
                      className={[
                        "text-center transition-colors hover:text-fg",
                        currentSort === "usage-desc" ? "font-medium text-fg" : "",
                      ].join(" ")}
                      onClick={() => { updateSort("usage-desc"); }}
                    >
                      {t("tags.list.col_count")}
                    </button>
                    <div />
                  </div>
                )}

                {data.items.map((tag) => (
                  <TagRow
                    key={tag.id}
                    tag={tag}
                    maxCount={data.maxBookmarkCount}
                    isSelected={selected?.id === tag.id}
                    onSelect={(t) => { setSelected((s) => s?.id === t.id ? null : t); }}
                    onRenameRequest={(t) => { setEditTarget(t); }}
                    onDeleteRequest={(t) => { setDeleteTarget(t); }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel: tag detail */}
        {selected && (
          <TagDetailPanel
            tag={selected}
            onClose={() => { setSelected(null); }}
            onRenameRequest={(t) => { setEditTarget(t); }}
            onDeleteRequest={(t) => { setDeleteTarget(t); }}
          />
        )}
      </div>

      {/* Create modal */}
      <TagModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        mode="create"
        onSubmit={handleCreateSubmit}
      />

      {/* Edit / rename modal */}
      <TagModal
        open={!!editTarget}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        mode="edit"
        initialName={editTarget?.name ?? ""}
        initialColor={editTarget?.color ?? null}
        onSubmit={handleEditSubmit}
      />

      {/* Delete confirmation modal */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("tags.modal.delete_title")}
        description={
          deleteTarget
            ? t("tags.modal.delete_body", {
                name: deleteTarget.name,
                count: String(deleteTarget.bookmarkCount),
              })
            : undefined
        }
        confirmLabel={t("tags.modal.delete_confirm")}
        cancelLabel={t("tags.modal.delete_cancel")}
        onConfirm={() => { void handleDeleteConfirm(); }}
        destructive
        testId="tag-delete-confirm-dialog"
      />
    </div>
  );
}
