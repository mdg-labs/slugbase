import { Button, Input } from "@slugbase/ui";
import { Banner, Confirm, FormField, FormOverlay, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { rateLimitMessage } from "../bookmarks/rate-limit-message.ts";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { TAG_NAME_MAX_LENGTH, mergeTag, readAllTags, refreshTagViews, renameTag, tagFailureOf, tagNamed, type Tag, type TagFailure } from "./tags.ts";

// The refusals the form tells in place, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_IN_THE_FORM = inPlaceRefusals([
  { status: 409, code: "name_taken" },
  { status: 422 },
  { status: 404, code: "not_found" },
  { status: 429, code: "rate_limited" },
]);

export interface TagRenameFormProps {
  /** The tag to rename, as listed. */
  readonly tag: Tag;
  /** Called with the tag that received the links once a merge went through. */
  readonly onMerged: (target: Tag) => void;
  readonly onClose: () => void;
}

/**
 * The form that renames a tag (doc 03 section 7, `form-overlay`). A name the member already uses for another tag is not
 * refused: the API says so, the form reads the member's tags again, never trusting the list the page holds, and offers to
 * merge this tag into the one that holds the name now through a `confirm` that states what moves. When that read fails, or
 * no other tag holds the name any more, no merge is offered. Declining returns to the form with what was typed. A rename or merge that fails keeps the form open and says why
 * where the refusal is one the member can act on.
 */
export function TagRenameForm({ tag, onMerged, onClose }: TagRenameFormProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [name, setName] = useState(tag.name);
  const [nameRequired, setNameRequired] = useState(false);
  const [failure, setFailure] = useState<TagFailure | undefined>(undefined);
  const [merging, setMerging] = useState<Tag | undefined>(undefined);
  const [mergeFailure, setMergeFailure] = useState<TagFailure | undefined>(undefined);

  const rename = useMutation({
    mutationKey: ["tags", "rename"],
    meta: SHOWN_IN_THE_FORM,
    mutationFn: (next: string): Promise<Tag> => renameTag(api, tag.id, next),
    onSuccess: () => {
      refreshTagViews(queryClient);
      feedbackToast.success(t("tags.form.saved"));
      onClose();
    },
    onError: async (error, next) => {
      const reason = tagFailureOf(error);
      if (reason?.kind === "nameTaken") {
        // The list the page holds may be out of date (a tag renamed or made on another device): the merge goes to whoever
        // holds the name in a fresh read, and to no one on a read that failed.
        let holder: Tag | undefined;
        let readFailed = false;
        try {
          holder = tagNamed(await readAllTags(api), next, tag.id);
        } catch {
          readFailed = true;
        }
        refreshTagViews(queryClient);
        if (holder !== undefined) {
          setMerging(holder);
          return;
        }
        // Nothing to merge into: the name is shown as taken when it could not be checked, and the member tries again when it is free now.
        setFailure(readFailed ? reason : undefined);
        return;
      }
      if (reason?.kind === "notFound") {
        refreshTagViews(queryClient);
      }
      setFailure(reason);
    },
  });

  const merge = useMutation({
    mutationKey: ["tags", "merge"],
    meta: inPlaceRefusals([{ status: 404, code: "not_found" }, { status: 422 }, { status: 429, code: "rate_limited" }]),
    mutationFn: (target: Tag): Promise<Tag> => mergeTag(api, tag.id, target.id),
    onSuccess: (target) => {
      refreshTagViews(queryClient);
      feedbackToast.success(t("tags.merge.merged", { name: target.name }));
      setMerging(undefined);
      onMerged(target);
      onClose();
    },
    onError: (error) => {
      const reason = tagFailureOf(error);
      if (reason?.kind === "notFound") {
        // One of the two tags is gone: the list is out of date.
        refreshTagViews(queryClient);
      }
      setMergeFailure(reason);
    },
  });

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (rename.isPending) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameRequired(true);
      return;
    }
    if (trimmed === tag.name) {
      onClose();
      return;
    }
    setFailure(undefined);
    rename.mutate(trimmed);
  }

  function failureMessage(value: TagFailure): string | undefined {
    switch (value.kind) {
      case "nameTaken":
        return t("tags.form.name.error.taken");
      case "invalidName":
        return t("tags.form.name.error.invalid", { max: TAG_NAME_MAX_LENGTH });
      case "notFound":
        return t("tags.form.error.notFound");
      case "rateLimited":
        return rateLimitMessage(t, value.seconds);
      case "unavailable":
        // Nothing the member can act on here; the shared error toast says the change was not saved.
        return undefined;
    }
  }

  const nameFailure = failure?.kind === "nameTaken" || failure?.kind === "invalidName";
  const shown = failure === undefined ? undefined : failureMessage(failure);
  const mergeShown = mergeFailure === undefined ? undefined : failureMessage(mergeFailure);

  return (
    <>
      <FormOverlay
        closeLabel={t("tags.form.close")}
        description={t("tags.form.description")}
        onOpenChange={(open) => {
          if (!open && !rename.isPending && !merge.isPending) {
            onClose();
          }
        }}
        open
        title={t("tags.form.title")}
      >
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {shown === undefined || nameFailure ? null : <Banner title={shown} variant="error" />}
          <FormField
            error={nameFailure ? shown : nameRequired ? t("tags.form.name.error.required") : undefined}
            label={t("tags.form.name.label")}
            name="name"
          >
            <Input
              autoComplete="off"
              disabled={rename.isPending}
              maxLength={TAG_NAME_MAX_LENGTH}
              onChange={(event) => {
                setName(event.target.value);
                setNameRequired(false);
                if (nameFailure) {
                  setFailure(undefined);
                }
              }}
              value={name}
            />
          </FormField>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={rename.isPending} onClick={onClose} type="button" variant="outline">
              {t("tags.form.cancel")}
            </Button>
            <Button loading={rename.isPending} type="submit">
              {t("tags.form.submit")}
            </Button>
          </div>
        </form>
      </FormOverlay>
      <Confirm
        cancelLabel={t("tags.merge.cancel")}
        confirmLabel={t("tags.merge.confirm")}
        description={
          <>
            {t("tags.merge.description", { count: tag.bookmarkCount, from: tag.name, into: merging?.name ?? "" })}
            {mergeShown === undefined ? null : (
              <span className="mt-3 block text-destructive-text" role="alert">
                {mergeShown}
              </span>
            )}
          </>
        }
        loading={merge.isPending}
        onConfirm={() => {
          if (merging !== undefined) {
            merge.mutate(merging);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setMerging(undefined);
            setMergeFailure(undefined);
          }
        }}
        open={merging !== undefined}
        title={t("tags.merge.title", { into: merging?.name ?? "" })}
      />
    </>
  );
}
