import { Button, Input } from "@slugbase/ui";
import { Banner, Confirm, Disclosure, FormField, FormOverlay, SettingSwitch, TextareaField, UnsavedGuard, UrlInput, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState, type KeyboardEvent, type ReactElement, type SyntheticEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Slot } from "../extensions/index.ts";
import {
  BOOKMARKS_QUERY_KEY,
  BOOKMARK_DESCRIPTION_MAX_LENGTH,
  BOOKMARK_TITLE_MAX_LENGTH,
  BOOKMARK_URL_MAX_LENGTH,
  bookmarkFailureOf,
  bookmarksByUrlQuery,
  createBookmark,
  deleteBookmark,
  isHttpUrl,
  updateBookmark,
  validateCreate,
  validateUpdate,
  type Bookmark,
  type BookmarkFailure,
  type CreateBookmarkRequest,
  type FieldName,
  type FieldProblem,
  type FieldProblems,
  type UpdateBookmarkRequest,
} from "./bookmarks.ts";

const SECONDS_PER_MINUTE = 60;

interface Values {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly pinned: boolean;
}

export interface BookmarkEditorProps {
  /** The bookmark to change, as loaded; none to create one. */
  bookmark?: Bookmark | undefined;
  /** The address a new bookmark starts with. */
  initialUrl?: string | undefined;
  /** Leaves the modal; the editor has already asked about unsaved changes. */
  onClose: () => void;
  /** Moves the modal to another bookmark, the one the duplicate warning names. */
  onEditExisting: (id: string) => void;
  /** Reads the bookmark again after a change elsewhere; true when it was read. */
  onReload?: (() => Promise<boolean>) | undefined;
}

function valuesOf(bookmark: Bookmark | undefined, initialUrl: string | undefined): Values {
  return {
    url: bookmark?.url ?? initialUrl ?? "",
    title: bookmark?.title ?? "",
    description: bookmark?.description ?? "",
    pinned: bookmark?.pinned ?? false,
  };
}

function useFieldMessage(): (field: FieldName, problem: FieldProblem | undefined) => string | undefined {
  const { t } = useTranslation();
  function tooLong(field: FieldName): string {
    switch (field) {
      case "url":
        return t("bookmarks.modal.url.error.tooLong", { max: BOOKMARK_URL_MAX_LENGTH });
      case "title":
        return t("bookmarks.modal.title.error.tooLong", { max: BOOKMARK_TITLE_MAX_LENGTH });
      case "description":
        return t("bookmarks.modal.description.error.tooLong", { max: BOOKMARK_DESCRIPTION_MAX_LENGTH });
    }
  }
  return (field, problem) => {
    switch (problem) {
      case undefined:
        return undefined;
      case "required":
        return field === "url" ? t("bookmarks.modal.url.error.required") : t("bookmarks.modal.title.error.required");
      case "tooLong":
        return tooLong(field);
      case "notAllowed":
        return t("bookmarks.modal.url.error.notAllowed");
      case "invalid":
        return field === "url" ? t("bookmarks.modal.url.error.invalid") : t("bookmarks.modal.error.invalid");
    }
  };
}

function FailureBanner({ failure, reloading, onReload }: { failure: BookmarkFailure; reloading: boolean; onReload: (() => void) | undefined }): ReactElement | null {
  const { t } = useTranslation();
  switch (failure.kind) {
    case "fields":
      return null;
    case "limitReached":
      return (
        <div className="flex flex-col gap-3">
          <Banner description={t("bookmarks.modal.error.limitReached.description")} title={t("bookmarks.modal.error.limitReached.title")} variant="warning" />
          <Slot name="entitlement.upgradeAction" />
        </div>
      );
    case "changedElsewhere":
      return (
        <Banner
          action={
            onReload === undefined ? undefined : (
              <Button loading={reloading} onClick={onReload} size="sm" variant="outline">
                {t("bookmarks.modal.error.changedElsewhere.reload")}
              </Button>
            )
          }
          description={t("bookmarks.modal.error.changedElsewhere.description")}
          title={t("bookmarks.modal.error.changedElsewhere.title")}
          variant="warning"
        />
      );
    case "notFound":
      return <Banner description={t("bookmarks.modal.error.notFound.description")} title={t("bookmarks.modal.error.notFound.title")} variant="error" />;
    case "rateLimited":
      return <Banner title={rateLimitMessage(t, failure.seconds)} variant="error" />;
    case "unavailable":
      return <Banner title={t("bookmarks.modal.error.unavailable")} variant="error" />;
    case "loadFailed":
      return <Banner title={t("bookmarks.modal.error.loadFailed")} variant="error" />;
  }
}

function rateLimitMessage(t: TFunction, seconds: number | undefined): string {
  if (seconds === undefined) {
    return t("reauth.error.rateLimited.unknown");
  }
  return seconds < SECONDS_PER_MINUTE
    ? t("reauth.error.rateLimited.seconds", { count: seconds })
    : t("reauth.error.rateLimited.minutes", { count: Math.ceil(seconds / SECONDS_PER_MINUTE) });
}

function deleteFailureMessage(t: TFunction, failure: BookmarkFailure): string {
  switch (failure.kind) {
    case "notFound":
      return t("bookmarks.modal.error.notFound.title");
    case "rateLimited":
      return rateLimitMessage(t, failure.seconds);
    default:
      return t("bookmarks.modal.delete.error.unavailable");
  }
}

type Request =
  | { readonly kind: "create"; readonly body: CreateBookmarkRequest }
  | { readonly kind: "update"; readonly id: string; readonly version: number; readonly body: UpdateBookmarkRequest };

/**
 * The bookmark form in its overlay (doc 02 sections 5.2 and 5.3, doc 03 section 4): the address, the title, a description
 * under "More" and the pin, for a new bookmark or one loaded to change. A change is sent against the version that was
 * loaded, so one made elsewhere is refused and offered to be read again instead of being overwritten. Closing with
 * unsaved changes asks first. When the address is left, pasted or prefilled, the caller's own bookmarks with the same
 * canonical address are looked up and named in a warning; saving a duplicate stays allowed.
 */
export function BookmarkEditor({ bookmark, initialUrl, onClose, onEditExisting, onReload }: BookmarkEditorProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const fieldMessage = useFieldMessage();
  const editing = bookmark !== undefined;
  const [initial] = useState(() => valuesOf(bookmark, initialUrl));
  const [values, setValues] = useState<Values>(initial);
  const [problems, setProblems] = useState<FieldProblems>({});
  const [failure, setFailure] = useState<BookmarkFailure | undefined>(undefined);
  const [reloading, setReloading] = useState(false);
  const [lookupUrl, setLookupUrl] = useState<string | undefined>(() => {
    const url = initial.url.trim();
    return !editing && isHttpUrl(url) ? url : undefined;
  });
  const [discard, setDiscard] = useState<{ readonly run: () => void } | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<BookmarkFailure | undefined>(undefined);
  const pasted = useRef(false);

  const lookup = useQuery(bookmarksByUrlQuery(api, lookupUrl));
  const trimmedUrl = values.url.trim();
  const lookupCurrent = lookupUrl !== undefined && lookupUrl === trimmedUrl;
  const duplicate = lookupCurrent ? lookup.data?.find(({ id }) => id !== bookmark?.id) : undefined;

  const dirty = values.url !== initial.url || values.title !== initial.title || values.description !== initial.description || values.pinned !== initial.pinned;

  const save = useMutation({
    mutationKey: ["bookmarks", "save"],
    mutationFn: (request: Request): Promise<Bookmark> =>
      request.kind === "create" ? createBookmark(api, request.body) : updateBookmark(api, request.id, request.version, request.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      feedbackToast.success(editing ? t("bookmarks.modal.saved.updated") : t("bookmarks.modal.saved.created"));
      onClose();
    },
    onError: (error) => {
      const next = bookmarkFailureOf(error);
      if (next?.kind === "fields") {
        setProblems(next.problems);
        return;
      }
      setFailure(next);
    },
  });

  const remove = useMutation({
    mutationKey: ["bookmarks", "delete"],
    mutationFn: (): Promise<void> => (bookmark === undefined ? Promise.resolve() : deleteBookmark(api, bookmark.id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      feedbackToast.success(t("bookmarks.modal.deleted"));
      onClose();
    },
    onError: (error) => {
      setDeleteFailure(bookmarkFailureOf(error) ?? { kind: "unavailable" });
    },
  });

  const busy = save.isPending || remove.isPending || reloading;

  function change(next: Partial<Values>): void {
    setValues((current) => ({ ...current, ...next }));
    setFailure(undefined);
  }

  function lookUp(url: string): void {
    // The bookmark being changed has its own address; only another bookmark of the caller's is a duplicate.
    if (isHttpUrl(url) && !(bookmark !== undefined && url === bookmark.url)) {
      setLookupUrl(url);
    }
  }

  function requestExit(leave: () => void): void {
    if (busy) {
      return;
    }
    if (dirty) {
      setDiscard({ run: leave });
      return;
    }
    leave();
  }

  function submit(): void {
    if (busy) {
      return;
    }
    setFailure(undefined);
    const url = values.url.trim();
    const title = values.title.trim();
    const description = values.description.trim();
    if (bookmark === undefined) {
      const body: CreateBookmarkRequest = { url, title, ...(description === "" ? {} : { description }), ...(values.pinned ? { pinned: true } : {}) };
      const found = validateCreate(body);
      setProblems(found);
      if (Object.keys(found).length === 0) {
        save.mutate({ kind: "create", body });
      }
      return;
    }
    const body: UpdateBookmarkRequest = {
      ...(url === bookmark.url ? {} : { url }),
      ...(title === bookmark.title ? {} : { title }),
      ...(description === (bookmark.description ?? "") ? {} : { description: description === "" ? null : description }),
      ...(values.pinned === bookmark.pinned ? {} : { pinned: values.pinned }),
    };
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    const found = validateUpdate(body);
    setProblems(found);
    if (Object.keys(found).length === 0) {
      save.mutate({ kind: "update", id: bookmark.id, version: bookmark.version, body });
    }
  }

  function onFormSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  async function reload(): Promise<void> {
    if (onReload === undefined) {
      return;
    }
    setReloading(true);
    const read = await onReload().catch(() => false);
    if (!read) {
      setReloading(false);
      setFailure({ kind: "loadFailed" });
    }
  }

  const urlError = fieldMessage("url", problems.url);
  const titleError = fieldMessage("title", problems.title);
  const descriptionError = fieldMessage("description", problems.description);
  const slugged = bookmark?.slug !== null && bookmark?.slug !== undefined;
  return (
    <>
      <FormOverlay
        closeLabel={t("bookmarks.modal.close")}
        onOpenChange={(open) => {
          if (!open) {
            requestExit(onClose);
          }
        }}
        open
        title={editing ? t("bookmarks.modal.edit.title") : t("bookmarks.modal.create.title")}
      >
        <form className="flex flex-col gap-4" noValidate onKeyDown={onKeyDown} onSubmit={onFormSubmit}>
          {failure === undefined ? null : (
            <FailureBanner
              failure={failure}
              onReload={
                onReload === undefined
                  ? undefined
                  : () => {
                      void reload();
                    }
              }
              reloading={reloading}
            />
          )}
          <FormField error={urlError} label={t("bookmarks.modal.url.label")} name="url">
            <UrlInput
              disabled={busy}
              onBlur={() => {
                lookUp(values.url.trim());
              }}
              onPaste={() => {
                pasted.current = true;
              }}
              onValueChange={(url) => {
                change({ url });
                setProblems((current) => ({ ...current, url: undefined }));
                if (pasted.current) {
                  pasted.current = false;
                  lookUp(url.trim());
                }
              }}
              pending={lookupCurrent && lookup.fetchStatus === "fetching"}
              pendingLabel={t("bookmarks.modal.url.checking")}
              placeholder={t("bookmarks.modal.url.placeholder")}
              value={values.url}
            />
          </FormField>
          {duplicate === undefined ? null : (
            <Banner
              action={
                <Button
                  disabled={busy}
                  onClick={() => {
                    requestExit(() => {
                      onEditExisting(duplicate.id);
                    });
                  }}
                  size="sm"
                  variant="outline"
                >
                  {t("bookmarks.modal.duplicate.edit")}
                </Button>
              }
              description={t("bookmarks.modal.duplicate.description", { title: duplicate.title })}
              title={t("bookmarks.modal.duplicate.title")}
              variant="warning"
            />
          )}
          {lookupCurrent && lookup.isError ? <Banner title={t("bookmarks.modal.duplicate.unchecked")} variant="info" /> : null}
          <FormField error={titleError} label={t("bookmarks.modal.title.label")} name="title">
            <Input
              autoComplete="off"
              disabled={busy}
              maxLength={BOOKMARK_TITLE_MAX_LENGTH}
              onValueChange={(title) => {
                change({ title });
                setProblems((current) => ({ ...current, title: undefined }));
              }}
              value={values.title}
            />
          </FormField>
          <Disclosure defaultOpen={initial.description !== "" || problems.description !== undefined} label={t("bookmarks.modal.more")}>
            <TextareaField
              counter={t("bookmarks.modal.description.counter", { count: values.description.length, max: BOOKMARK_DESCRIPTION_MAX_LENGTH })}
              disabled={busy}
              error={descriptionError}
              label={t("bookmarks.modal.description.label")}
              maxLength={BOOKMARK_DESCRIPTION_MAX_LENGTH}
              name="description"
              onChange={(description) => {
                change({ description });
                setProblems((current) => ({ ...current, description: undefined }));
              }}
              value={values.description}
            />
          </Disclosure>
          <SettingSwitch
            checked={values.pinned}
            description={t("bookmarks.modal.pinned.description")}
            disabled={busy}
            label={t("bookmarks.modal.pinned.label")}
            name="pinned"
            onCheckedChange={(pinned) => {
              change({ pinned });
            }}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            {editing ? (
              <Button
                className="sm:me-auto"
                disabled={busy}
                onClick={() => {
                  setDeleteFailure(undefined);
                  setConfirmingDelete(true);
                }}
                variant="destructive-outline"
              >
                {t("bookmarks.modal.delete.label")}
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={() => {
                requestExit(onClose);
              }}
              variant="outline"
            >
              {t("bookmarks.modal.cancel")}
            </Button>
            <Button disabled={reloading || remove.isPending} loading={save.isPending} type="submit">
              {t("bookmarks.modal.save")}
            </Button>
          </div>
        </form>
      </FormOverlay>
      <UnsavedGuard
        description={t("bookmarks.modal.unsaved.description")}
        discardLabel={t("bookmarks.modal.unsaved.discard")}
        keepEditingLabel={t("bookmarks.modal.unsaved.keepEditing")}
        onDiscard={() => {
          const pending = discard;
          setDiscard(undefined);
          pending?.run();
        }}
        onKeepEditing={() => {
          setDiscard(undefined);
        }}
        open={discard !== undefined}
        title={t("bookmarks.modal.unsaved.title")}
      />
      <Confirm
        cancelLabel={t("bookmarks.modal.cancel")}
        confirmLabel={t("bookmarks.modal.delete.confirm")}
        description={
          <>
            {slugged ? t("bookmarks.modal.delete.descriptionSlug", { title: bookmark.title }) : t("bookmarks.modal.delete.description", { title: bookmark?.title ?? "" })}
            {deleteFailure === undefined ? null : (
              <span className="mt-3 block text-destructive-text" role="alert">
                {deleteFailureMessage(t, deleteFailure)}
              </span>
            )}
          </>
        }
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          setDeleteFailure(undefined);
          remove.mutate();
        }}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDelete(false);
          }
        }}
        open={confirmingDelete}
        title={t("bookmarks.modal.delete.title")}
      />
    </>
  );
}
