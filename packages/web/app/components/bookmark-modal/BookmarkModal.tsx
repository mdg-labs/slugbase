import {
  Button,
  Dialog,
  DialogContent,
  FieldError,
  Input,
  Label,
} from "@slugbase/ui";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { BookmarkModalAiSuggestion } from "./ai/BookmarkModalAiSuggestion.js";
import { BookmarkModalAiTagSuggestions } from "./ai/BookmarkModalAiTagSuggestions.js";
import type { BookmarkModalAiContext } from "./ai/bookmark-modal-ai.types.js";
import { DEFAULT_BOOKMARK_MODAL_AI_CONTEXT } from "./ai/bookmark-modal-ai.types.js";
import type { FetchAiSuggestionsFn } from "./ai/bookmark-modal-ai.types.js";
import { useBookmarkModalAiSuggestions } from "./ai/use-bookmark-modal-ai-suggestions.js";
import { ShareControls } from "../sharing/ShareControls.js";
import { useWorkspaceEntitlements } from "../sharing/use-workspace-entitlements.js";
import type {
  BookmarkModalFieldErrors,
  BookmarkModalFolderOption,
  BookmarkModalFormValues,
  BookmarkModalInitialBookmark,
  BookmarkModalMode,
  BookmarkModalSubmitPayload,
  BookmarkModalTagOption,
} from "./bookmark-modal.types.js";
import { EMPTY_BOOKMARK_FORM } from "./bookmark-modal.types.js";
import {
  hasBookmarkModalErrors,
  validateBookmarkModalForm,
} from "./bookmark-modal.validation.js";

function formFromBookmark(bookmark: BookmarkModalInitialBookmark): BookmarkModalFormValues {
  return {
    url: bookmark.url,
    title: bookmark.title,
    slug: bookmark.slug ?? "",
    folderIds: [...bookmark.folderIds],
    newFolderNames: [],
    tagIds: [...bookmark.tagIds],
    newTagNames: [],
    pinned: bookmark.pinned,
    forwardingEnabled: bookmark.forwardingEnabled,
  };
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

/* ---------- V2-style Folder Selector: dropdown with multi-select + nested create ---------- */

type FolderSelectorProps = {
  folders: BookmarkModalFolderOption[];
  selectedIds: string[];
  newFolderNames: string[];
  onToggle: (id: string) => void;
  onAddNewFolder: (name: string) => void;
  onRemoveNewFolder: (name: string) => void;
  label: string;
  emptyLabel: string;
  createFolderLabel: string;
  createFolderNameLabel: string;
  createFolderNamePlaceholder: string;
  createFolderConfirm: string;
  createFolderCancel: string;
};

function FolderSelector({
  folders,
  selectedIds,
  newFolderNames,
  onToggle,
  onAddNewFolder,
  onRemoveNewFolder,
  label,
  emptyLabel,
  createFolderLabel,
  createFolderNameLabel,
  createFolderNamePlaceholder,
  createFolderConfirm,
  createFolderCancel,
}: FolderSelectorProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) {
      createInputRef.current?.focus();
    }
  }, [creating]);

  const handleOutsideClick = useCallback((e: MouseEvent) => {
    if (
      containerRef.current &&
      !containerRef.current.contains(e.target as Node)
    ) {
      setOpen(false);
      setCreating(false);
      setNewName("");
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => { document.removeEventListener("mousedown", handleOutsideClick); };
    }
    return undefined;
  }, [open, handleOutsideClick]);

  const selectedCount = selectedIds.length + newFolderNames.length;

  const triggerLabel = (() => {
    if (selectedCount === 0) return label;
    if (selectedCount === 1) {
      const folder = folders.find((f) => f.id === selectedIds[0]);
      return folder ? folder.name : newFolderNames[0];
    }
    return t("bookmark.modal.folders_selected_count", { count: selectedCount });
  })();

  const handleCreateSubmit = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onAddNewFolder(trimmed);
    setNewName("");
    setCreating(false);
    setOpen(false);
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCreateSubmit();
    }
    if (e.key === "Escape") {
      setCreating(false);
      setNewName("");
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          setCreating(false);
          setNewName("");
        }}
        className="flex h-8 w-full items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-raised px-sp-3 text-left text-fg transition-colors hover:bg-raised-2 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
        style={{ fontSize: "var(--text-small)" }}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="folder-selector-trigger"
      >
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <svg
          className="h-3.5 w-3.5 shrink-0 text-fg-subtle"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{
            transition: "transform 110ms ease",
            transform: open ? "rotate(180deg)" : "none",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-full overflow-hidden rounded-md border border-[color:var(--border-strong)] bg-overlay shadow-overlay"
          role="listbox"
          aria-label={label}
          data-testid="folder-selector-menu"
        >
          {creating ? (
            <div className="flex flex-col gap-sp-2 p-sp-3">
              <Label
                className="text-fg-muted"
                style={{ fontSize: "var(--text-micro)" }}
              >
                {createFolderNameLabel}
              </Label>
              <input
                ref={createInputRef}
                type="text"
                value={newName}
                onChange={(e) => { setNewName(e.target.value); }}
                onKeyDown={handleCreateKeyDown}
                placeholder={createFolderNamePlaceholder}
                className="h-7 rounded border border-[color:var(--border)] bg-raised px-sp-2 text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
                style={{ fontSize: "var(--text-small)" }}
                data-testid="folder-create-name-input"
              />
              <div className="flex gap-sp-2">
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                  className="h-7 flex-1 rounded border border-[color:var(--border-subtle)] bg-raised text-fg-muted transition-colors hover:bg-raised-2 hover:text-fg"
                  style={{ fontSize: "var(--text-small)" }}
                >
                  {createFolderCancel}
                </button>
                <button
                  type="button"
                  onClick={handleCreateSubmit}
                  disabled={!newName.trim()}
                  className="h-7 flex-1 rounded bg-accent text-white transition-colors hover:opacity-90 disabled:opacity-40"
                  style={{ fontSize: "var(--text-small)" }}
                  data-testid="folder-create-confirm"
                >
                  {createFolderConfirm}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { setCreating(true); }}
                className="flex w-full items-center gap-sp-2 border-b border-[color:var(--border-subtle)] px-sp-3 py-sp-2 text-left text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                style={{ fontSize: "var(--text-small)" }}
                data-testid="folder-create-trigger"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded border border-dashed border-[color:var(--border)]">
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </span>
                {createFolderLabel}
              </button>

              {folders.length === 0 && newFolderNames.length === 0 ? (
                <p
                  className="px-sp-3 py-sp-2 text-fg-subtle"
                  style={{ fontSize: "var(--text-small)" }}
                >
                  {emptyLabel}
                </p>
              ) : (
                <>
                  {folders.map((folder) => (
                    <button
                      type="button"
                      key={folder.id}
                      onClick={() => { onToggle(folder.id); }}
                      className="flex w-full items-center gap-sp-2 px-sp-3 py-sp-2 text-left transition-colors hover:bg-raised"
                      style={{ fontSize: "var(--text-small)" }}
                      role="option"
                      aria-selected={selectedIds.includes(folder.id)}
                    >
                      <span
                        className="min-w-0 flex-1 truncate text-fg"
                      >
                        {folder.name}
                      </span>
                      {selectedIds.includes(folder.id) ? (
                        <svg
                          className="h-3.5 w-3.5 shrink-0 text-accent"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : null}
                    </button>
                  ))}
                  {newFolderNames.map((name) => (
                    <button
                      type="button"
                      key={`new-${name}`}
                      onClick={() => { onRemoveNewFolder(name); }}
                      className="flex w-full items-center gap-sp-2 px-sp-3 py-sp-2 text-left transition-colors hover:bg-raised"
                      style={{ fontSize: "var(--text-small)" }}
                      role="option"
                      aria-selected={true}
                    >
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {name}
                      </span>
                      <svg
                        className="h-3.5 w-3.5 shrink-0 text-accent"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- V2-style Tag Selector: pill-input with type-ahead ---------- */

type TagSelectorProps = {
  tags: BookmarkModalTagOption[];
  selectedIds: string[];
  newTagNames: string[];
  onToggleId: (id: string) => void;
  onAddNewTag: (name: string) => void;
  onRemoveNewTag: (name: string) => void;
  inputPlaceholder: string;
};

function TagSelector({
  tags,
  selectedIds,
  newTagNames,
  onToggleId,
  onAddNewTag,
  onRemoveNewTag,
  inputPlaceholder,
}: TagSelectorProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);

  const filteredSuggestions = useMemo(() => {
    const qLower = q.toLowerCase();
    return tags
      .filter((t) => {
        const nameMatch = qLower
          ? t.name.toLowerCase().includes(qLower)
          : true;
        const notSelected = !selectedIds.includes(t.id);
        return nameMatch && notSelected;
      })
      .slice(0, 8);
  }, [tags, q, selectedIds]);

  const showSuggestions = focused && filteredSuggestions.length > 0;

  const exactMatch = useMemo(() => {
    const trimmed = q.trim().toLowerCase();
    if (!trimmed) return false;
    return (
      !tags.some((t) => t.name.toLowerCase() === trimmed) &&
      !newTagNames.some((n) => n.toLowerCase() === trimmed)
    );
  }, [q, tags, newTagNames]);

  const addNewTag = useCallback(
    (name: string) => {
      const clean = name.trim().toLowerCase().replace(/^#/, "");
      if (!clean) return;
      onAddNewTag(clean);
      setQ("");
    },
    [onAddNewTag],
  );

  const removeLastSelectedTag = useCallback(() => {
    if (newTagNames.length > 0) {
      const last = newTagNames[newTagNames.length - 1];
      if (last !== undefined) onRemoveNewTag(last);
    } else if (selectedIds.length > 0) {
      const last = selectedIds[selectedIds.length - 1];
      if (last !== undefined) onToggleId(last);
    }
  }, [newTagNames, selectedIds, onRemoveNewTag, onToggleId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === ",") && q.trim()) {
        e.preventDefault();
        addNewTag(q);
      }
      if (e.key === "Backspace" && !q) {
        removeLastSelectedTag();
      }
    },
    [q, addNewTag, removeLastSelectedTag],
  );

  const handleSuggestionClick = useCallback(
    (tagId: string) => {
      onToggleId(tagId);
      setQ("");
      inputRef.current?.focus();
    },
    [onToggleId],
  );

  const selectedTags = useMemo(() => {
    return selectedIds
      .map((id) => tags.find((t) => t.id === id))
      .filter((t): t is BookmarkModalTagOption => t != null);
  }, [selectedIds, tags]);

  return (
    <div className="relative">
      <div
        className={`flex min-h-8 flex-wrap items-center gap-1 rounded-md border bg-raised px-sp-2 py-sp-1 transition-colors ${
          focused
            ? "border-[color:var(--accent)] ring-1 ring-[color:var(--accent)]"
            : "border-[color:var(--border)]"
        }`}
        onClick={() => { inputRef.current?.focus(); }}
        data-testid="tag-selector"
      >
        {selectedTags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-[color:var(--border-subtle)] bg-raised-2 text-fg-muted"
            style={{
              height: "22px",
              padding: "0 6px",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-micro)",
              fontWeight: "var(--weight-medium)",
              lineHeight: "1",
            }}
          >
            <span aria-hidden="true" style={{ opacity: 0.45 }}>
              #
            </span>
            {tag.name}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleId(tag.id);
              }}
              className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-[color:var(--border-subtle)] hover:text-fg"
              aria-label={t("bookmark.modal.tags_remove_aria", { name: tag.name })}
              data-testid={`tag-remove-${tag.id}`}
            >
              <svg
                className="h-2.5 w-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </span>
        ))}
        {newTagNames.map((name) => (
          <span
            key={`new-${name}`}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-[color:var(--accent-subtle)] bg-accent-subtle text-accent-text"
            style={{
              height: "22px",
              padding: "0 6px",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-micro)",
              fontWeight: "var(--weight-medium)",
              lineHeight: "1",
            }}
          >
            <span aria-hidden="true" style={{ opacity: 0.45 }}>
              #
            </span>
            {name}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveNewTag(name);
              }}
              className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-accent-text/60 transition-colors hover:bg-accent-subtle hover:text-accent-text"
              aria-label={t("bookmark.modal.tags_remove_aria", { name })}
              data-testid={`tag-remove-new-${name}`}
            >
              <svg
                className="h-2.5 w-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); }}
          onKeyDown={handleKeyDown}
          onFocus={() => { setFocused(true); }}
          onBlur={() => {
            setTimeout(() => { setFocused(false); }, 150);
          }}
          placeholder={
            selectedTags.length === 0 && newTagNames.length === 0
              ? inputPlaceholder
              : ""
          }
          className="min-w-[80px] flex-1 bg-transparent py-0.5 text-fg placeholder:text-fg-subtle focus:outline-none"
          style={{ fontSize: "var(--text-small)" }}
          data-testid="tag-input"
        />
      </div>

      {showSuggestions ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 max-h-32 w-full overflow-y-auto rounded-md border border-[color:var(--border-strong)] bg-overlay shadow-overlay"
          role="listbox"
          data-testid="tag-suggestions"
        >
          {filteredSuggestions.map((tag) => (
            <button
              type="button"
              key={tag.id}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSuggestionClick(tag.id);
              }}
              className="flex w-full items-center gap-sp-2 px-sp-3 py-sp-2 text-left transition-colors hover:bg-raised"
              style={{ fontSize: "var(--text-small)" }}
              role="option"
            >
              <span
                className="text-fg-subtle"
                style={{ opacity: 0.45 }}
                aria-hidden="true"
              >
                #
              </span>
              <span className="text-fg">{tag.name}</span>
            </button>
          ))}
          {exactMatch ? (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                addNewTag(q);
              }}
              className="flex w-full items-center gap-sp-2 border-t border-[color:var(--border-subtle)] px-sp-3 py-sp-2 text-left text-accent transition-colors hover:bg-raised"
              style={{ fontSize: "var(--text-small)" }}
              data-testid="tag-create-option"
            >
              <svg
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {q.trim()}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Main modal ---------- */

export type BookmarkModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BookmarkModalMode;
  bookmark?: BookmarkModalInitialBookmark;
  folders: BookmarkModalFolderOption[];
  tags: BookmarkModalTagOption[];
  onSubmit: (payload: BookmarkModalSubmitPayload) => Promise<void>;
  isSubmitting?: boolean;
  aiContext?: BookmarkModalAiContext;
  fetchAiSuggestions?: FetchAiSuggestionsFn;
  optionsError?: string | null;
  onRetryOptions?: () => void;
};

export function BookmarkModal({
  open,
  onOpenChange,
  mode,
  bookmark,
  folders,
  tags,
  onSubmit,
  isSubmitting = false,
  aiContext = DEFAULT_BOOKMARK_MODAL_AI_CONTEXT,
  fetchAiSuggestions,
  optionsError,
  onRetryOptions,
}: BookmarkModalProps) {
  const { t } = useTranslation();
  const { canShare, currentUserId } = useWorkspaceEntitlements();
  const formId = useId();
  const urlErrorId = `${formId}-url-error`;
  const titleErrorId = `${formId}-title-error`;
  const slugErrorId = `${formId}-slug-error`;
  const formErrorId = `${formId}-form-error`;

  const [values, setValues] = useState<BookmarkModalFormValues>(EMPTY_BOOKMARK_FORM);
  const [errors, setErrors] = useState<BookmarkModalFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const ai = useBookmarkModalAiSuggestions({
    open,
    url: values.url,
    aiContext,
    fetchSuggestions: fetchAiSuggestions,
  });

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSubmitError(null);
    setValues(
      mode === "edit" && bookmark ? formFromBookmark(bookmark) : EMPTY_BOOKMARK_FORM,
    );
  }, [open, mode, bookmark]);

  const titleKey =
    mode === "create"
      ? "bookmark.modal.title_create"
      : "bookmark.modal.title_edit";

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);

    const nextErrors = validateBookmarkModalForm(values, t);
    setErrors(nextErrors);
    if (hasBookmarkModalErrors(nextErrors)) {
      return;
    }

    const payload: BookmarkModalSubmitPayload = {
      ...values,
      mode,
      bookmarkId: bookmark?.id,
    };

    try {
      await onSubmit(payload);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : t("bookmark.modal.error.submit_failed"),
      );
    }
  };

  const slugPreview =
    values.slug.trim().length > 0 && values.forwardingEnabled
      ? `/go/${values.slug.trim()}`
      : null;

  const suggestions = ai.status === "ready" ? ai.suggestions : null;
  const showTitleSuggestion =
    suggestions != null &&
    suggestions.title.trim().length > 0 &&
    values.title.trim() !== suggestions.title.trim();
  const showSlugSuggestion =
    suggestions != null &&
    suggestions.slug.trim().length > 0 &&
    values.slug.trim() !== suggestions.slug.trim().toLowerCase();
  const showTagSuggestions =
    suggestions != null && suggestions.tags.length > 0 && tags.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        testId="bookmark-modal"
        title={t(titleKey)}
        description={
          mode === "create" ? t("bookmark.modal.subtitle_create") : undefined
        }
      >
        <form
          id={formId}
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          noValidate
        >
          <div className="flex min-h-0 flex-1 flex-col gap-sp-6 overflow-y-auto px-sp-8 py-sp-6">
            {optionsError ? (
              <div
                className="rounded-md border border-[color:var(--danger-border,#f0686b33)] bg-[color:var(--danger-bg,#f0686b0d)] px-sp-4 py-sp-3 text-[color:var(--danger-fg,#f0686b)]"
                style={{ fontSize: "var(--text-small)" }}
                role="alert"
                data-testid="options-load-error"
              >
                {t("bookmark.modal.error.load_options_inline")}
                {onRetryOptions ? (
                  <button
                    type="button"
                    className="ml-sp-2 underline"
                    onClick={onRetryOptions}
                  >
                    {t("bookmark.modal.error.load_options_retry")}
                  </button>
                ) : null}
              </div>
            ) : null}
            {/* URL */}
            <div className="flex flex-col gap-sp-2">
              <Label htmlFor={`${formId}-url`}>{t("bookmark.modal.url_label")}</Label>
              <Input
                id={`${formId}-url`}
                name="url"
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder={t("bookmark.modal.url_placeholder")}
                value={values.url}
                invalid={Boolean(errors.url)}
                aria-describedby={errors.url ? urlErrorId : undefined}
                onChange={(event) => {
                  setValues((current) => ({ ...current, url: event.target.value }));
                }}
              />
              {errors.url ? <FieldError id={urlErrorId}>{errors.url}</FieldError> : null}
            </div>

            {/* Title */}
            <div className="flex flex-col gap-sp-2">
              <Label htmlFor={`${formId}-title`}>
                {t("bookmark.modal.title_label")}
              </Label>
              <Input
                id={`${formId}-title`}
                name="title"
                type="text"
                autoComplete="off"
                placeholder={t("bookmark.modal.title_placeholder")}
                value={values.title}
                invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? titleErrorId : undefined}
                onChange={(event) => {
                  setValues((current) => ({ ...current, title: event.target.value }));
                }}
              />
              {errors.title ? (
                <FieldError id={titleErrorId}>{errors.title}</FieldError>
              ) : null}
              {showTitleSuggestion ? (
                <BookmarkModalAiSuggestion
                  fieldLabel={t("bookmark.modal.title_label")}
                  value={suggestions.title}
                  onApply={() => {
                    setValues((current) => ({
                      ...current,
                      title: suggestions.title,
                    }));
                  }}
                />
              ) : null}
              {ai.enabled && ai.status === "loading" ? (
                <p
                  className="text-fg-subtle"
                  style={{
                    fontSize: "var(--text-small)",
                    lineHeight: "var(--lh-small)",
                  }}
                  data-testid="bookmark-modal-ai-loading"
                >
                  {t("bookmark.modal.ai.loading")}
                </p>
              ) : null}
            </div>

            {/* Slug */}
            <div className="flex flex-col gap-sp-2">
              <Label htmlFor={`${formId}-slug`}>{t("bookmark.modal.slug_label")}</Label>
              <div className="flex items-center overflow-hidden rounded-md border border-[color:var(--border)] bg-raised focus-within:ring-1 focus-within:ring-[color:var(--accent)]">
                <span
                  className="flex h-full shrink-0 items-center border-r border-[color:var(--border-subtle)] bg-raised-2 px-sp-3 font-mono text-fg-subtle"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.slug_prefix")}
                </span>
                <input
                  id={`${formId}-slug`}
                  name="slug"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("bookmark.modal.slug_placeholder")}
                  value={values.slug}
                  aria-describedby={errors.slug ? slugErrorId : undefined}
                  aria-invalid={Boolean(errors.slug) || undefined}
                  className="min-w-0 flex-1 bg-transparent px-sp-3 py-sp-2 font-mono text-fg placeholder:text-fg-faint focus:outline-none"
                  style={{ fontSize: "var(--text-body)" }}
                  onChange={(event) => {
                    setValues((current) => ({
                      ...current,
                      slug: event.target.value.toLowerCase(),
                    }));
                  }}
                />
              </div>
              {errors.slug ? <FieldError id={slugErrorId}>{errors.slug}</FieldError> : null}
              {showSlugSuggestion ? (
                <BookmarkModalAiSuggestion
                  fieldLabel={t("bookmark.modal.slug_label")}
                  value={suggestions.slug}
                  onApply={() => {
                    setValues((current) => ({
                      ...current,
                      slug: suggestions.slug.toLowerCase(),
                    }));
                  }}
                />
              ) : null}
              {slugPreview ? (
                <p
                  className="font-mono text-accent-text"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.forwarding_address", { address: slugPreview })}
                </p>
              ) : null}
            </div>

            {/* Folders + Tags */}
            <div className="grid gap-sp-6 sm:grid-cols-2">
              <fieldset className="flex min-w-0 flex-col gap-sp-3">
                <legend
                  className="font-medium text-fg-muted"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.folders_label")}
                </legend>
                <FolderSelector
                  folders={folders}
                  selectedIds={values.folderIds}
                  newFolderNames={values.newFolderNames}
                  onToggle={(id) => {
                    setValues((current) => ({
                      ...current,
                      folderIds: toggleId(current.folderIds, id),
                    }));
                  }}
                  onAddNewFolder={(name) => {
                    setValues((current) => ({
                      ...current,
                      newFolderNames: [...current.newFolderNames, name],
                    }));
                  }}
                  onRemoveNewFolder={(name) => {
                    setValues((current) => ({
                      ...current,
                      newFolderNames: current.newFolderNames.filter((n) => n !== name),
                    }));
                  }}
                  label={t("bookmark.modal.folders_select_placeholder")}
                  emptyLabel={t("bookmark.modal.folders_empty")}
                  createFolderLabel={t("bookmark.modal.folders_create_trigger")}
                  createFolderNameLabel={t("bookmark.modal.folders_create_name_label")}
                  createFolderNamePlaceholder={t("bookmark.modal.folders_create_name_placeholder")}
                  createFolderConfirm={t("bookmark.modal.folders_create_confirm")}
                  createFolderCancel={t("bookmark.modal.folders_create_cancel")}
                />
              </fieldset>

              <fieldset className="flex min-w-0 flex-col gap-sp-3">
                <legend
                  className="font-medium text-fg-muted"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.tags_label")}
                </legend>
                {showTagSuggestions ? (
                  <BookmarkModalAiTagSuggestions
                    suggestedNames={suggestions.tags}
                    tags={tags}
                    selectedTagIds={values.tagIds}
                    onToggleTag={(tagId) => {
                      setValues((current) => ({
                        ...current,
                        tagIds: current.tagIds.includes(tagId)
                          ? current.tagIds.filter((id) => id !== tagId)
                          : [...current.tagIds, tagId],
                      }));
                    }}
                  />
                ) : null}
                <TagSelector
                  tags={tags}
                  selectedIds={values.tagIds}
                  newTagNames={values.newTagNames}
                  onToggleId={(id) => {
                    setValues((current) => ({
                      ...current,
                      tagIds: toggleId(current.tagIds, id),
                    }));
                  }}
                  onAddNewTag={(name) => {
                    setValues((current) => ({
                      ...current,
                      newTagNames: [...current.newTagNames, name],
                    }));
                  }}
                  onRemoveNewTag={(name) => {
                    setValues((current) => ({
                      ...current,
                      newTagNames: current.newTagNames.filter((n) => n !== name),
                    }));
                  }}
                  inputPlaceholder={t("bookmark.modal.tags_input_placeholder")}
                />
              </fieldset>
            </div>

            {/* Pin + Forwarding */}
            <div className="flex flex-col gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-5">
              <label className="flex cursor-pointer items-start gap-sp-4">
                <input
                  type="checkbox"
                  checked={values.pinned}
                  aria-label={t("bookmark.modal.pin_label")}
                  onChange={(event) => {
                    setValues((current) => ({
                      ...current,
                      pinned: event.target.checked,
                    }));
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-[color:var(--border)] accent-accent"
                />
                <span className="flex flex-col gap-sp-2">
                  <span
                    className="font-medium text-fg"
                    style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
                  >
                    {t("bookmark.modal.pin_label")}
                  </span>
                  <span
                    className="text-fg-muted"
                    style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                  >
                    {t("bookmark.modal.pin_hint")}
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-sp-4">
                <input
                  type="checkbox"
                  checked={values.forwardingEnabled}
                  aria-label={t("bookmark.modal.forwarding_label")}
                  onChange={(event) => {
                    setValues((current) => ({
                      ...current,
                      forwardingEnabled: event.target.checked,
                    }));
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-[color:var(--border)] accent-accent"
                />
                <span className="flex flex-col gap-sp-2">
                  <span
                    className="font-medium text-fg"
                    style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
                  >
                    {t("bookmark.modal.forwarding_label")}
                  </span>
                  <span
                    className="text-fg-muted"
                    style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                  >
                    {t("bookmark.modal.forwarding_hint")}
                  </span>
                </span>
              </label>
            </div>

            {/* Sharing */}
            <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--raised)] p-sp-5">
              <p
                className="font-medium text-fg"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              >
                {t("bookmark.modal.sharing_label")}
              </p>
              {mode === "edit" && bookmark ? (
                canShare ? (
                  <div className="mt-sp-4">
                    <ShareControls
                      resourceKind="bookmark"
                      resourceId={bookmark.id}
                      resourceTitle={bookmark.title}
                      ownerUserId={currentUserId}
                    />
                  </div>
                ) : (
                  <p
                    className="mt-sp-2 text-fg-subtle"
                    style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                  >
                    {t("sharing.upgrade_required")}
                  </p>
                )
              ) : (
                <p
                  className="mt-sp-2 text-fg-subtle"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.sharing_after_save")}
                </p>
              )}
            </div>

            {submitError ? (
              <FieldError id={formErrorId}>{submitError}</FieldError>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-sp-4 border-t border-[color:var(--border-subtle)] px-sp-8 py-sp-5">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={isSubmitting}
            >
              {t("bookmark.modal.cancel")}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? t("bookmark.modal.submit_loading")
                : mode === "create"
                  ? t("bookmark.modal.submit_create")
                  : t("bookmark.modal.submit_edit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
