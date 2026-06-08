import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigate, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { AlertTriangleIcon, ExternalLinkIcon, HashIcon, LinkIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button, EmptyState } from "@slugbase/ui";
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

interface TagRowProps {
  tag: TagListItem;
  maxCount: number;
  isSelected: boolean;
  isRenaming: boolean;
  isDelConfirm: boolean;
  renameVal: string;
  onSelect: (tag: TagListItem) => void;
  onRenameStart: (tag: TagListItem) => void;
  onRenameChange: (val: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelConfirm: (tag: TagListItem) => void;
  onDelCancel: () => void;
  onDelCommit: (tag: TagListItem) => void;
}

function TagRow({
  tag,
  maxCount,
  isSelected,
  isRenaming,
  isDelConfirm,
  renameVal,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelConfirm,
  onDelCancel,
  onDelCommit,
}: TagRowProps) {
  const { t } = useTranslation();
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [isRenaming]);

  return (
    <div>
      <div
        className={[
          "group grid cursor-pointer items-center gap-sp-4 rounded-md px-sp-4 py-sp-3 transition-colors",
          "hover:bg-[color:var(--raised-2)]",
          isSelected ? "bg-[color:var(--raised-2)] ring-1 ring-[color:var(--accent)]" : "",
        ].join(" ")}
        style={{ gridTemplateColumns: "1fr 180px 80px 80px" }}
        onClick={() => { if (!isRenaming) onSelect(tag); }}
        data-testid={`tag-row-${tag.id}`}
      >
        <div className="min-w-0">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameVal}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => { onRenameChange(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { onRenameCommit(); }
                if (e.key === "Escape") { onRenameCancel(); }
              }}
              onBlur={onRenameCommit}
              onClick={(e) => { e.stopPropagation(); }}
              className="w-full rounded border border-[color:var(--accent)] bg-[color:var(--base)] px-sp-3 py-sp-1 text-fg outline-none"
              style={{ fontSize: "var(--text-body)", fontFamily: "var(--font-mono)" }}
              maxLength={200}
            />
          ) : (
            <span
              className="truncate text-fg"
              style={{ fontSize: "var(--text-body)", fontFamily: "var(--font-mono)" }}
            >
              #{tag.name}
            </span>
          )}
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
            onClick={() => { onRenameStart(tag); }}
          >
            <PencilIcon size={14} />
          </button>
          <button
            type="button"
            title={t("tags.list.action_delete")}
            aria-label={t("tags.list.action_delete")}
            className="inline-flex items-center justify-center rounded p-sp-1 text-[color:var(--danger-text)] transition-colors hover:bg-[color:var(--overlay)]"
            onClick={() => { onDelConfirm(tag); }}
          >
            <Trash2Icon size={14} />
          </button>
        </div>
      </div>

      {isDelConfirm && (
        <div className="mx-sp-2 mb-sp-2 flex flex-wrap items-center gap-sp-3 rounded-md border border-[color:var(--border)] bg-[color:var(--raised)] px-sp-4 py-sp-3">
          <AlertTriangleIcon size={14} className="shrink-0 text-[color:var(--warning-text)]" />
          <span className="flex-1 text-fg-muted" style={{ fontSize: "var(--text-small)" }}>
            {t("tags.list.delete_inline_body", {
              name: tag.name,
              count: String(tag.bookmarkCount),
            })}
          </span>
          <div className="flex gap-sp-2">
            <Button variant="danger" size="sm" type="button" onClick={() => { onDelCommit(tag); }}>
              {t("tags.list.delete_confirm")}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={onDelCancel}>
              {t("tags.list.delete_cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

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
    void fetchTaggedBookmarks(tag.id).then((items) => {
      if (!cancelled) {
        setBookmarks(items);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [tag.id]);

  return (
    <div className="flex h-full flex-col border-l border-[color:var(--border)] bg-[color:var(--base)]" data-testid="tag-detail-panel">
      <div className="border-b border-[color:var(--border)] p-sp-5">
        <div className="mb-sp-3 flex items-center justify-between">
          <span
            className="truncate font-semibold text-fg"
            style={{ fontSize: "var(--text-h3)", fontFamily: "var(--font-mono)" }}
          >
            #{tag.name}
          </span>
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

interface NewTagInlineProps {
  onSaved: () => void;
  onCancel: () => void;
}

function NewTagInline({ onSaved, onCancel }: NewTagInlineProps) {
  const { t } = useTranslation();
  const { showToast, showError } = useAppToast();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await createTag(trimmed);
      showToast("tags.list.toast_created");
      onSaved();
    } catch {
      showError(t("tags.list.error_create"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex items-center gap-sp-3 rounded-md border border-[color:var(--accent)] bg-[color:var(--raised)] px-sp-4 py-sp-3"
      onSubmit={(e) => { void handleSubmit(e); }}
      data-testid="new-tag-inline"
    >
      <HashIcon size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
      <input
        ref={inputRef}
        value={name}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setName(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        placeholder={t("tags.list.new_placeholder")}
        className="flex-1 bg-transparent text-fg outline-none placeholder:text-fg-muted"
        style={{ fontSize: "var(--text-body)", fontFamily: "var(--font-mono)" }}
        maxLength={200}
      />
      <Button type="submit" variant="primary" size="sm" disabled={submitting || !name.trim()}>
        {submitting ? t("tags.list.new_saving") : t("tags.list.new_save")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        {t("tags.list.new_cancel")}
      </Button>
    </form>
  );
}

export function TagListPage() {
  const { t } = useTranslation();
  const data = useLoaderData<TagListData>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const { showToast, showError } = useAppToast();

  const [selected, setSelected] = useState<TagListItem | null>(null);
  const [renaming, setRenaming] = useState<TagListItem | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [delConfirm, setDelConfirm] = useState<TagListItem | null>(null);
  const [showNewInline, setShowNewInline] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);

  const isLoading = navigation.state === "loading";
  const currentSort = isTagSort(data.sort) ? data.sort : "usage-desc";
  const currentSortLabel = SORT_OPTIONS.find((s) => s.value === currentSort)?.labelKey ?? "tags.list.sort_most_used";

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setRenaming(null);
        setDelConfirm(null);
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

  const startRename = (tag: TagListItem) => {
    setRenaming(tag);
    setRenameVal(tag.name);
    setDelConfirm(null);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renameVal.trim();
    if (!trimmed || trimmed === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      await renameTag(renaming.id, trimmed);
      if (selected?.id === renaming.id) {
        setSelected({ ...selected, name: trimmed });
      }
      showToast("tags.list.toast_renamed");
      void revalidator.revalidate();
    } catch {
      showError(t("tags.list.error_rename"));
    }
    setRenaming(null);
  };

  const commitDelete = async (tag: TagListItem) => {
    try {
      await deleteTag(tag.id);
      if (selected?.id === tag.id) setSelected(null);
      setDelConfirm(null);
      showToast("tags.list.toast_deleted");
      void revalidator.revalidate();
    } catch {
      showError(t("tags.list.error_delete"));
    }
  };

  const handleNewSaved = () => {
    setShowNewInline(false);
    void revalidator.revalidate();
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
              <div className="flex min-w-[180px] max-w-[220px] flex-1 items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-3">
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
                          <span className="text-[color:var(--accent)]">✓</span>
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
                onClick={() => { setShowNewInline(true); }}
                data-testid="tag-list-new-btn"
              >
                <PlusIcon size={15} className="shrink-0" />
                {t("tags.list.new_action")}
              </Button>
            </div>

          <div className="flex-1 overflow-y-auto p-sp-7">
            {showNewInline && (
              <div className="mb-sp-3">
                <NewTagInline
                  onSaved={handleNewSaved}
                  onCancel={() => { setShowNewInline(false); }}
                />
              </div>
            )}

            {data.items.length === 0 && !showNewInline ? (
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
                    isRenaming={renaming?.id === tag.id}
                    isDelConfirm={delConfirm?.id === tag.id}
                    renameVal={renaming?.id === tag.id ? renameVal : tag.name}
                    onSelect={(t) => { setSelected((s) => s?.id === t.id ? null : t); setDelConfirm(null); }}
                    onRenameStart={startRename}
                    onRenameChange={setRenameVal}
                    onRenameCommit={() => { void commitRename(); }}
                    onRenameCancel={() => { setRenaming(null); }}
                    onDelConfirm={(t) => { setDelConfirm(t); setRenaming(null); }}
                    onDelCancel={() => { setDelConfirm(null); }}
                    onDelCommit={(t) => { void commitDelete(t); }}
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
            onRenameRequest={startRename}
            onDeleteRequest={(tag) => { setDelConfirm(tag); setRenaming(null); }}
          />
        )}
      </div>
    </div>
  );
}
