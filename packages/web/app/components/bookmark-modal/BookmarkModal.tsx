import {
  Button,
  Dialog,
  DialogContent,
  FieldError,
  Input,
  Label,
} from "@slugbase/ui";
import { useTranslate } from "@tolgee/react";
import { useEffect, useId, useState } from "react";

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
    pinned: bookmark.pinned,
    forwardingEnabled: bookmark.forwardingEnabled,
  };
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export type BookmarkModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BookmarkModalMode;
  bookmark?: BookmarkModalInitialBookmark;
  folders: BookmarkModalFolderOption[];
  tags: BookmarkModalTagOption[];
  onSubmit: (payload: BookmarkModalSubmitPayload) => Promise<void>;
  isSubmitting?: boolean;
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
}: BookmarkModalProps) {
  const { t } = useTranslate();
  const formId = useId();
  const urlErrorId = `${formId}-url-error`;
  const titleErrorId = `${formId}-title-error`;
  const slugErrorId = `${formId}-slug-error`;
  const formErrorId = `${formId}-form-error`;

  const [values, setValues] = useState<BookmarkModalFormValues>(EMPTY_BOOKMARK_FORM);
  const [errors, setErrors] = useState<BookmarkModalFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

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
            </div>

            <div className="flex flex-col gap-sp-2">
              <Label htmlFor={`${formId}-slug`}>{t("bookmark.modal.slug_label")}</Label>
              <div className="flex items-center gap-sp-3">
                <span
                  className="shrink-0 font-mono text-fg-subtle"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.slug_prefix")}
                </span>
                <Input
                  id={`${formId}-slug`}
                  name="slug"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("bookmark.modal.slug_placeholder")}
                  value={values.slug}
                  invalid={Boolean(errors.slug)}
                  aria-describedby={errors.slug ? slugErrorId : undefined}
                  className="font-mono"
                  onChange={(event) => {
                    setValues((current) => ({
                      ...current,
                      slug: event.target.value.toLowerCase(),
                    }));
                  }}
                />
              </div>
              {errors.slug ? <FieldError id={slugErrorId}>{errors.slug}</FieldError> : null}
              {slugPreview ? (
                <p
                  className="font-mono text-accent-text"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.forwarding_address", { address: slugPreview })}
                </p>
              ) : null}
            </div>

            <div className="grid gap-sp-6 sm:grid-cols-2">
              <fieldset className="flex min-w-0 flex-col gap-sp-3">
                <legend
                  className="font-medium text-fg-muted"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.folders_label")}
                </legend>
                {folders.length === 0 ? (
                  <p
                    className="text-fg-subtle"
                    style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                  >
                    {t("bookmark.modal.folders_empty")}
                  </p>
                ) : (
                  <div className="flex max-h-36 flex-col gap-sp-2 overflow-y-auto rounded-md border border-[color:var(--border-subtle)] bg-raised p-sp-3">
                    {folders.map((folder) => (
                      <label
                        key={folder.id}
                        className="flex cursor-pointer items-center gap-sp-3 rounded-md px-sp-2 py-sp-2 hover:bg-raised-2"
                      >
                        <input
                          type="checkbox"
                          checked={values.folderIds.includes(folder.id)}
                          onChange={() => {
                            setValues((current) => ({
                              ...current,
                              folderIds: toggleId(current.folderIds, folder.id),
                            }));
                          }}
                          className="h-4 w-4 rounded border-[color:var(--border)] accent-accent"
                        />
                        <span
                          className="truncate text-fg"
                          style={{
                            fontSize: "var(--text-body)",
                            lineHeight: "var(--lh-body)",
                          }}
                        >
                          {folder.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <fieldset className="flex min-w-0 flex-col gap-sp-3">
                <legend
                  className="font-medium text-fg-muted"
                  style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                >
                  {t("bookmark.modal.tags_label")}
                </legend>
                {tags.length === 0 ? (
                  <p
                    className="text-fg-subtle"
                    style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
                  >
                    {t("bookmark.modal.tags_empty")}
                  </p>
                ) : (
                  <div className="flex max-h-36 flex-col gap-sp-2 overflow-y-auto rounded-md border border-[color:var(--border-subtle)] bg-raised p-sp-3">
                    {tags.map((tag) => (
                      <label
                        key={tag.id}
                        className="flex cursor-pointer items-center gap-sp-3 rounded-md px-sp-2 py-sp-2 hover:bg-raised-2"
                      >
                        <input
                          type="checkbox"
                          checked={values.tagIds.includes(tag.id)}
                          onChange={() => {
                            setValues((current) => ({
                              ...current,
                              tagIds: toggleId(current.tagIds, tag.id),
                            }));
                          }}
                          className="h-4 w-4 rounded border-[color:var(--border)] accent-accent"
                        />
                        <span
                          className="truncate text-fg"
                          style={{
                            fontSize: "var(--text-body)",
                            lineHeight: "var(--lh-body)",
                          }}
                        >
                          {tag.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            </div>

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

            <div
              className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--raised)] p-sp-5 opacity-70"
              aria-disabled="true"
            >
              <p
                className="font-medium text-fg-muted"
                style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
              >
                {t("bookmark.modal.sharing_label")}
              </p>
              <p
                className="mt-sp-2 text-fg-subtle"
                style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
              >
                {t("bookmark.modal.sharing_placeholder")}
              </p>
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
