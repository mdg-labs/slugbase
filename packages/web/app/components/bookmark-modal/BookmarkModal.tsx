import {
  Button,
  Dialog,
  DialogContent,
  FieldError,
  Input,
  Label,
} from "@slugbase/ui";
import { useTranslation } from "react-i18next";
import { useEffect, useId, useRef, useState } from "react";

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
    tagIds: [...bookmark.tagIds],
    newTagNames: [],
    pinned: bookmark.pinned,
    forwardingEnabled: bookmark.forwardingEnabled,
  };
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

/* ---------- Searchable folder selector ---------- */

type FolderSelectorProps = {
  folders: BookmarkModalFolderOption[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  searchPlaceholder: string;
  emptyLabel: string;
};

function FolderSelector({
  folders,
  selectedIds,
  onToggle,
  searchPlaceholder,
  emptyLabel,
}: FolderSelectorProps) {
  const [q, setQ] = useState("");
  const filtered = q
    ? folders.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
    : folders;

  if (folders.length === 0) {
    return (
      <p
        className="text-fg-subtle"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-sp-2">
      <input
        type="search"
        value={q}
        onChange={(e) => { setQ(e.target.value); }}
        placeholder={searchPlaceholder}
        className="h-7 w-full rounded border border-[color:var(--border)] bg-raised px-sp-3 text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
        style={{ fontSize: "var(--text-small)" }}
      />
      <div className="flex max-h-32 flex-col gap-sp-1 overflow-y-auto rounded-md border border-[color:var(--border-subtle)] bg-raised p-sp-2">
        {filtered.length === 0 ? (
          <p
            className="px-sp-2 py-sp-1 text-fg-subtle"
            style={{ fontSize: "var(--text-small)" }}
          >
            {q}
          </p>
        ) : (
          filtered.map((folder) => (
            <label
              key={folder.id}
              className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-2 py-sp-2 hover:bg-raised-2"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(folder.id)}
                onChange={() => { onToggle(folder.id); }}
                className="h-4 w-4 rounded border-[color:var(--border)] accent-accent"
              />
              <span
                className="truncate text-fg"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              >
                {folder.name}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------- Tag multi-select with type-ahead + inline create ---------- */

type TagSelectorProps = {
  tags: BookmarkModalTagOption[];
  selectedIds: string[];
  newTagNames: string[];
  onToggleId: (id: string) => void;
  onAddNewTag: (name: string) => void;
  onRemoveNewTag: (name: string) => void;
  searchPlaceholder: string;
  emptyLabel: string;
  createLabel: (name: string) => string;
};

function TagSelector({
  tags,
  selectedIds,
  newTagNames,
  onToggleId,
  onAddNewTag,
  onRemoveNewTag,
  searchPlaceholder,
  emptyLabel,
  createLabel,
}: TagSelectorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");

  const filtered = q
    ? tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()))
    : tags;

  const exactMatch =
    q.trim().length > 0 &&
    !tags.some((t) => t.name.toLowerCase() === q.trim().toLowerCase()) &&
    !newTagNames.some((n) => n.toLowerCase() === q.trim().toLowerCase());

  const handleCreate = () => {
    const name = q.trim();
    if (!name) return;
    onAddNewTag(name);
    setQ("");
    inputRef.current?.focus();
  };

  const allNewSelected = newTagNames.length > 0;

  return (
    <div className="flex flex-col gap-sp-2">
      {allNewSelected ? (
        <div className="flex flex-wrap gap-sp-2">
          {newTagNames.map((name) => (
            <span
              key={name}
              className="flex items-center gap-sp-2 rounded-full border border-[color:var(--border)] bg-raised-2 px-sp-3 py-sp-1"
              style={{ fontSize: "var(--text-small)" }}
            >
              <span className="text-fg">{name}</span>
              <button
                type="button"
                onClick={() => { onRemoveNewTag(name); }}
                className="text-fg-subtle hover:text-fg"
                aria-label={`Remove tag ${name}`}
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {tags.length === 0 && newTagNames.length === 0 ? (
        <p
          className="text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {emptyLabel}
        </p>
      ) : (
        <div className="flex gap-sp-2">
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && exactMatch) {
                e.preventDefault();
                handleCreate();
              }
            }}
            placeholder={searchPlaceholder}
            className="h-7 flex-1 rounded border border-[color:var(--border)] bg-raised px-sp-3 text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
            style={{ fontSize: "var(--text-small)" }}
          />
          {exactMatch ? (
            <button
              type="button"
              onClick={handleCreate}
              className="shrink-0 rounded border border-[color:var(--border)] bg-raised px-sp-3 text-fg-muted transition-colors hover:bg-raised-2 hover:text-fg"
              style={{ fontSize: "var(--text-small)" }}
            >
              {createLabel(q.trim())}
            </button>
          ) : null}
        </div>
      )}

      {(tags.length > 0 || filtered.length > 0) ? (
        <div className="flex max-h-32 flex-col gap-sp-1 overflow-y-auto rounded-md border border-[color:var(--border-subtle)] bg-raised p-sp-2">
          {filtered.map((tag) => (
            <label
              key={tag.id}
              className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-2 py-sp-2 hover:bg-raised-2"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(tag.id)}
                onChange={() => { onToggleId(tag.id); }}
                className="h-4 w-4 rounded border-[color:var(--border)] accent-accent"
              />
              <span
                className="truncate text-fg"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              >
                {tag.name}
              </span>
            </label>
          ))}
          {filtered.length === 0 && q ? (
            <p
              className="px-sp-2 py-sp-1 text-fg-subtle"
              style={{ fontSize: "var(--text-small)" }}
            >
              {q}
            </p>
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
                  onToggle={(id) => {
                    setValues((current) => ({
                      ...current,
                      folderIds: toggleId(current.folderIds, id),
                    }));
                  }}
                  searchPlaceholder={t("bookmark.modal.folders_search_placeholder")}
                  emptyLabel={t("bookmark.modal.folders_empty")}
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
                  searchPlaceholder={t("bookmark.modal.tags_search_placeholder")}
                  emptyLabel={t("bookmark.modal.tags_empty")}
                  createLabel={(name) => t("bookmark.modal.tags_create", { name })}
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
