import { Button, Input } from "@slugbase/ui";
import { Banner, Confirm, Disclosure, FormField, FormOverlay, SettingSwitch, TextareaField, UnsavedGuard, UrlInput, feedbackToast, useBusyFormFocus } from "@slugbase/ui/patterns";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type SyntheticEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Slot } from "../extensions/index.ts";
import { ShareDialog, SharingSummary, useIsOwner, type ShareSubject } from "../sharing/index.ts";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { FOLDERS_QUERY_KEY } from "../folders/folders.ts";
import { TAGS_QUERY_KEY, TAG_NAME_MAX_LENGTH } from "../tags/tags.ts";
import { useAllTags } from "../tags/use-all-tags.ts";
import { ShimmerOver, SuggestAction, SuggestionChips, suggestActionShown } from "./suggest-action.tsx";
import {
  NO_AI_STATE,
  acceptSlug,
  acceptTag,
  acceptTitle,
  aiFieldsOf,
  applySuggestion,
  localeOf,
  metadataOf,
  offeredTags,
  useAiAvailability,
  useAiSuggester,
  type AiField,
  type AiState,
} from "./ai-suggest.ts";
import { sameIds } from "./bookmark-choices.ts";
import { CREATE_FOLDER_MUTATION_KEY, FolderPick } from "./folder-pick.tsx";
import { rateLimitMessage } from "./rate-limit-message.ts";
import { SlugFields } from "./slug-fields.tsx";
import { TagPick } from "./tag-pick.tsx";
import { usePageMetadata } from "./use-page-metadata.ts";
import {
  BOOKMARKS_QUERY_KEY,
  BOOKMARK_DESCRIPTION_MAX_LENGTH,
  BOOKMARK_SLUG_MAX_LENGTH,
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
  type BookmarkMetadata,
  type CreateBookmarkRequest,
  type FieldName,
  type FieldProblem,
  type FieldProblems,
  type UpdateBookmarkRequest,
} from "./bookmarks.ts";

interface Values {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  /** Whether the title came with the bookmark or was typed by the member, and so is not replaced by what a page says. */
  readonly titleOwned: boolean;
  /** The same for the description. */
  readonly descriptionOwned: boolean;
  /** Trimmed and lower-cased as it is typed; empty for none. */
  readonly slug: string;
  readonly forwarding: boolean;
  readonly pinned: boolean;
  readonly folderIds: readonly string[];
  readonly tagIds: readonly string[];
  /** Tag names the member has no tag of yet; the API makes the tags with the bookmark. */
  readonly tagNames: readonly string[];
  /** The suggestions on offer, and the values taken from one, which the save counts (doc 02 section 14). */
  readonly ai: AiState;
}

/** Why a save did not go through: the failures of `bookmarkFailureOf`, and a folder or tag that is gone. */
type EditorFailure = BookmarkFailure | { readonly kind: "choiceNotFound" };

export interface BookmarkEditorProps {
  /** The bookmark to change, as loaded; none to create one. */
  bookmark?: Bookmark | undefined;
  /** The address a new bookmark starts with. */
  initialUrl?: string | undefined;
  /** The slug a new bookmark starts with. */
  initialSlug?: string | undefined;
  /** Leaves the modal; the editor has already asked about unsaved changes. */
  onClose: () => void;
  /** Moves the modal to another bookmark, the one the duplicate warning names. */
  onEditExisting: (id: string) => void;
  /** Reads the bookmark again after a change elsewhere; true when it was read. */
  onReload?: (() => Promise<boolean>) | undefined;
}

function valuesOf(bookmark: Bookmark | undefined, initialUrl: string | undefined, initialSlug: string | undefined): Values {
  const slug = bookmark === undefined ? (initialSlug ?? "").trim().toLowerCase() : (bookmark.slug ?? "");
  return {
    url: bookmark?.url ?? initialUrl ?? "",
    title: bookmark?.title ?? "",
    description: bookmark?.description ?? "",
    titleOwned: (bookmark?.title ?? "") !== "",
    descriptionOwned: (bookmark?.description ?? "") !== "",
    slug,
    forwarding: bookmark === undefined ? slug !== "" : bookmark.forwarding,
    pinned: bookmark?.pinned ?? false,
    folderIds: bookmark?.folders.map(({ id }) => id) ?? [],
    tagIds: bookmark?.tags.map(({ id }) => id) ?? [],
    tagNames: [],
    ai: NO_AI_STATE,
  };
}

/** A slug turns forwarding on when the bookmark had none, and without one there is nothing to forward. */
function forwardingAfter(before: Values, slug: string): boolean {
  if (slug === "") {
    return false;
  }
  return before.slug === "" ? true : before.forwarding;
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
      case "slug":
        return t("bookmarks.modal.slug.error.invalid", { max: BOOKMARK_SLUG_MAX_LENGTH });
      case "tagNames":
        return t("bookmarks.modal.tags.error.tooLong", { max: TAG_NAME_MAX_LENGTH });
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
      case "taken":
        return t("bookmarks.modal.slug.error.taken");
      case "invalid":
        if (field === "slug") {
          return t("bookmarks.modal.slug.error.invalid", { max: BOOKMARK_SLUG_MAX_LENGTH });
        }
        return field === "url" ? t("bookmarks.modal.url.error.invalid") : t("bookmarks.modal.error.invalid");
    }
  };
}

function FailureBanner({ failure, reloading, onReload }: { failure: EditorFailure; reloading: boolean; onReload: (() => void) | undefined }): ReactElement | null {
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
    case "choiceNotFound":
      return <Banner description={t("bookmarks.modal.error.choiceNotFound.description")} title={t("bookmarks.modal.error.choiceNotFound.title")} variant="error" />;
    case "rateLimited":
      return <Banner title={rateLimitMessage(t, failure.seconds)} variant="error" />;
    case "unavailable":
      return <Banner title={t("bookmarks.modal.error.unavailable")} variant="error" />;
    case "loadFailed":
      return <Banner title={t("bookmarks.modal.error.loadFailed")} variant="error" />;
  }
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

// The refusals of a save that `bookmarkFailureOf` and the editor tell in the modal, for which the shared error toast stays quiet; any
// other failure still raises it. A `404` is the bookmark, or a folder or tag, that is gone.
const SHOWN_IN_THE_MODAL = inPlaceRefusals([
  { status: 422, code: "validation_failed" },
  { status: 422, code: "url_not_allowed" },
  { status: 422, code: "bookmark_limit_reached" },
  { status: 409, code: "slug_taken" },
  { status: 412, code: "precondition_failed" },
  { status: 404, code: "not_found" },
  { status: 429, code: "rate_limited" },
]);

type Request =
  | { readonly kind: "create"; readonly body: CreateBookmarkRequest }
  | { readonly kind: "update"; readonly id: string; readonly version: number; readonly body: UpdateBookmarkRequest };

/**
 * The bookmark form in its overlay (doc 02 sections 5.2 and 5.3, doc 03 section 4): the address, the title, the folders and tags,
 * a description under "More" and the pin, for a new bookmark or one loaded to change. A change is sent against the version that was
 * loaded, so one made elsewhere is refused and offered to be read again instead of being overwritten. Closing with
 * unsaved changes asks first. When the address is left, pasted or prefilled, the caller's own bookmarks with the same
 * canonical address are looked up and named in a warning; saving a duplicate stays allowed. The same moments ask the API for the
 * title and description of the page (doc 02 section 5.4) and fill the two fields the member has not typed in; a page that cannot
 * be read changes nothing.
 */
export function BookmarkEditor({ bookmark, initialUrl, initialSlug, onClose, onEditExisting, onReload }: BookmarkEditorProps): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const fieldMessage = useFieldMessage();
  const editing = bookmark !== undefined;
  const [initial] = useState(() => valuesOf(bookmark, initialUrl, initialSlug));
  const [values, setValues] = useState<Values>(initial);
  const [problems, setProblems] = useState<FieldProblems>({});
  const [failure, setFailure] = useState<EditorFailure | undefined>(undefined);
  const [reloading, setReloading] = useState(false);
  const [lookupUrl, setLookupUrl] = useState<string | undefined>(() => {
    const url = initial.url.trim();
    return !editing && isHttpUrl(url) ? url : undefined;
  });
  const [discard, setDiscard] = useState<{ readonly run: () => void } | undefined>(undefined);
  const discardOpener = useRef<Element | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const owned = useIsOwner(bookmark?.ownerId ?? null);
  const [deleteFailure, setDeleteFailure] = useState<BookmarkFailure | undefined>(undefined);
  const pasted = useRef(false);
  const metadata = usePageMetadata(api);
  const availability = useAiAvailability();
  const suggester = useAiSuggester(api);
  const allTags = useAllTags();
  // What the page said about itself, with the address it was read for: the suggestion request carries it as it is.
  const page = useRef<{ readonly url: string; readonly title: string | null | undefined; readonly description: string | null | undefined } | undefined>(undefined);
  const latest = useRef<{ readonly values: Values; readonly tags: readonly { readonly id: string; readonly name: string }[] }>({ values: initial, tags: [] });

  const lookup = useQuery(bookmarksByUrlQuery(api, lookupUrl));
  const trimmedUrl = values.url.trim();
  const lookupCurrent = lookupUrl !== undefined && lookupUrl === trimmedUrl;
  const duplicate = lookupCurrent ? lookup.data?.find(({ id }) => id !== bookmark?.id) : undefined;

  const creatingFolder = useIsMutating({ mutationKey: CREATE_FOLDER_MUTATION_KEY }) > 0;

  const dirty =
    values.url !== initial.url ||
    (values.titleOwned && values.title !== initial.title) ||
    (values.descriptionOwned && values.description !== initial.description) ||
    values.slug !== initial.slug ||
    values.forwarding !== initial.forwarding ||
    values.pinned !== initial.pinned ||
    !sameIds(values.folderIds, initial.folderIds) ||
    !sameIds(values.tagIds, initial.tagIds) ||
    values.tagNames.length > 0;

  const save = useMutation({
    mutationKey: ["bookmarks", "save"],
    meta: SHOWN_IN_THE_MODAL,
    mutationFn: (request: Request): Promise<Bookmark> =>
      request.kind === "create" ? createBookmark(api, request.body) : updateBookmark(api, request.id, request.version, request.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
      // Filing and tagging move the counts of the folders and tags, and a new tag name made a tag.
      void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      feedbackToast.success(editing ? t("bookmarks.modal.saved.updated") : t("bookmarks.modal.saved.created"));
      onClose();
    },
    onError: (error, request) => {
      const next = bookmarkFailureOf(error);
      if (next?.kind === "fields") {
        setProblems(next.problems);
        return;
      }
      // The API answers a folder or tag that is not the member's, or was deleted since the lists were read, like a bookmark that is not found.
      if (next?.kind === "notFound" && (request.body.folderIds !== undefined || request.body.tagIds !== undefined)) {
        setFailure({ kind: "choiceNotFound" });
        void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
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

  const busy = save.isPending || remove.isPending || reloading || creatingFolder;
  const busyFocus = useBusyFormFocus(busy);
  const form = busyFocus.ref;

  function change(next: Partial<Values>): void {
    setValues((current) => ({ ...current, ...next }));
    setFailure(undefined);
  }

  useEffect(() => {
    latest.current = { values, tags: allTags.tags };
  });

  // The action goes when the API refuses it or a read turns it off, and a button that holds focus when it goes takes focus with it: in some browsers
  // focus then falls to the page, where a single key would act. Focus goes to the dialog only when it has fallen that far (onto the body, or nowhere);
  // anywhere else it is left alone, in the form, or in another overlay standing over it such as the discard question or the palette. That overlay
  // returns focus when it closes: to the element that had it when it opened, or, where that element went with the action, to the dialog
  // (`focusBack` of the palette, `discardFinalFocus` of the question).
  const actionOffered = availability.kind === "ready" && !suggester.refused;
  const actionWasOffered = useRef(actionOffered);
  useLayoutEffect(() => {
    if (actionWasOffered.current && !actionOffered) {
      const held = document.activeElement;
      const dialog = form.current?.closest<HTMLElement>("[role='dialog']");
      if (dialog && (held === null || held === document.body)) {
        dialog.focus();
      }
    }
    actionWasOffered.current = actionOffered;
  }, [actionOffered]);

  /** Where focus goes when the discard question closes: back to where it was, or into the dialog where that is gone, such as the action that was withdrawn. */
  function discardFinalFocus(): HTMLElement | boolean {
    const opener = discardOpener.current;
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
      return true;
    }
    return form.current?.closest<HTMLElement>("[role='dialog']") ?? true;
  }

  /** The control the label `text` names, for the chips of that field to hand focus to. */
  const fieldLabelled =
    (text: string) =>
    (): HTMLElement | null => {
      const label = Array.from(form.current?.querySelectorAll("label") ?? []).find((candidate) => candidate.textContent === text);
      return label?.control instanceof HTMLElement ? label.control : null;
    };

  const fillFromPage = useCallback((url: string, read: BookmarkMetadata): void => {
    page.current = { url, title: read.title, description: read.description };
    const title = (read.title ?? "").trim().slice(0, BOOKMARK_TITLE_MAX_LENGTH);
    const description = (read.description ?? "").trim().slice(0, BOOKMARK_DESCRIPTION_MAX_LENGTH);
    setValues((current) => ({
      ...current,
      ...(current.titleOwned ? {} : { title }),
      ...(current.descriptionOwned ? {} : { description }),
    }));
    setProblems((current) => ({ ...current, ...(title === "" ? {} : { title: undefined }) }));
  }, []);

  function prefill(url: string): void {
    // The bookmark being changed has its own address and title; only another address is read.
    if (isHttpUrl(url) && !(bookmark !== undefined && url === bookmark.url)) {
      metadata.request(url, (read) => {
        fillFromPage(url, read);
      });
    }
  }

  const { request: requestMetadata } = metadata;
  const startUrl = initial.url.trim();
  useEffect(() => {
    // A new bookmark that opens with an address, one pasted onto the page, is read like one pasted into the field.
    if (!editing && isHttpUrl(startUrl)) {
      requestMetadata(startUrl, (read) => {
        fillFromPage(startUrl, read);
      });
    }
  }, [editing, startUrl, requestMetadata, fillFromPage]);

  function suggest(): void {
    if (busy) {
      return;
    }
    const url = values.url.trim();
    if (!isHttpUrl(url)) {
      setProblems((current) => ({ ...current, url: url === "" ? "required" : "notAllowed" }));
      return;
    }
    setFailure(undefined);
    suggester.run(
      { url, locale: localeOf(i18n.language), metadata: page.current?.url === url ? metadataOf(page.current) : undefined, bookmarkId: bookmark?.id },
      (suggestion) => {
        // Applied to the form as it is when the answer comes: a field the member filled meanwhile gets a chip, and nothing they typed is replaced.
        const before = latest.current.values;
        const next = applySuggestion(before, suggestion, latest.current.tags);
        setValues(next);
        setProblems((current) => ({
          ...current,
          ...(next.title === before.title ? {} : { title: undefined }),
          ...(next.slug === before.slug ? {} : { slug: undefined }),
          ...(next.tagNames === before.tagNames && next.tagIds === before.tagIds ? {} : { tagNames: undefined }),
        }));
      },
    );
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
      discardOpener.current = document.activeElement;
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
    metadata.cancel();
    suggester.cancel();
    const url = values.url.trim();
    const title = values.title.trim();
    const description = values.description.trim();
    const aiFields = aiFieldsOf(values);
    if (bookmark === undefined) {
      const body: CreateBookmarkRequest = {
        url,
        title,
        ...(description === "" ? {} : { description }),
        ...(values.slug === "" ? {} : { slug: values.slug, forwarding: values.forwarding }),
        ...(values.pinned ? { pinned: true } : {}),
        ...(values.folderIds.length === 0 ? {} : { folderIds: [...values.folderIds] }),
        ...(values.tagIds.length === 0 ? {} : { tagIds: [...values.tagIds] }),
        ...(values.tagNames.length === 0 ? {} : { tagNames: [...values.tagNames] }),
        ...(aiFields.length === 0 ? {} : { aiFields }),
      };
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
      ...(values.slug === initial.slug ? {} : { slug: values.slug === "" ? null : values.slug }),
      ...(values.forwarding === bookmark.forwarding ? {} : { forwarding: values.forwarding }),
      ...(values.pinned === bookmark.pinned ? {} : { pinned: values.pinned }),
      ...(sameIds(values.folderIds, initial.folderIds) ? {} : { folderIds: [...values.folderIds] }),
      // The tags a patch names replace the bookmark's, so a change to them sends all of the ones that stay.
      ...(sameIds(values.tagIds, initial.tagIds) && values.tagNames.length === 0
        ? {}
        : { tagIds: [...values.tagIds], ...(values.tagNames.length === 0 ? {} : { tagNames: [...values.tagNames] }) }),
    };
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    // A patch that changes nothing counts nothing, so only the fields this patch sends can be named.
    const sent: AiField[] = [...(body.title === undefined ? [] : (["title"] as const)), ...(body.slug === undefined ? [] : (["slug"] as const)), ...(body.tagIds === undefined ? [] : (["tags"] as const))];
    const sentAiFields = aiFieldsOf(values, sent);
    const patch: UpdateBookmarkRequest = sentAiFields.length === 0 ? body : { ...body, aiFields: sentAiFields };
    const found = validateUpdate(patch);
    setProblems(found);
    if (Object.keys(found).length === 0) {
      save.mutate({ kind: "update", id: bookmark.id, version: bookmark.version, body: patch });
    }
  }

  function refuseTagName(): void {
    setProblems((current) => ({ ...current, tagNames: "tooLong" }));
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
  const tagsError = fieldMessage("tagNames", problems.tagNames);
  const slugError = fieldMessage("slug", problems.slug);
  const shareSubject: ShareSubject | undefined = bookmark === undefined ? undefined : { kind: "bookmark", id: bookmark.id, name: bookmark.title };
  const offer = values.ai.offer;
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
        headerAction={
          suggestActionShown({ availability, refused: suggester.refused, failed: suggester.failed }) ? (
            <SuggestAction availability={availability} failed={suggester.failed} onSuggest={suggest} refused={suggester.refused} running={suggester.running} />
          ) : undefined
        }
        title={editing ? t("bookmarks.modal.edit.title") : t("bookmarks.modal.create.title")}
      >
        <form className="flex flex-col gap-4" noValidate onKeyDown={onKeyDown} onSubmit={onFormSubmit} {...busyFocus}>
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
                // While the form saves, the focus leaves the field because the overlay keeps it, not because the member left the address.
                if (busy) {
                  return;
                }
                lookUp(values.url.trim());
                prefill(values.url.trim());
              }}
              onPaste={() => {
                pasted.current = true;
              }}
              onValueChange={(url) => {
                change({ url });
                // The chips on offer were made for the address that was there.
                setValues((current) => (current.ai.offer === undefined ? current : { ...current, ai: { ...current.ai, offer: undefined } }));
                setProblems((current) => ({ ...current, url: undefined }));
                metadata.follow(url.trim());
                suggester.follow(url.trim());
                if (pasted.current) {
                  pasted.current = false;
                  lookUp(url.trim());
                  prefill(url.trim());
                }
              }}
              pending={metadata.pending || (lookupCurrent && lookup.fetchStatus === "fetching")}
              pendingLabel={metadata.pending ? t("bookmarks.modal.url.reading") : t("bookmarks.modal.url.checking")}
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
            <ShimmerOver active={suggester.running && values.title.trim() === ""}>
              <Input
                autoComplete="off"
                disabled={busy}
                maxLength={BOOKMARK_TITLE_MAX_LENGTH}
                onValueChange={(title) => {
                  change({ title, titleOwned: true });
                  setProblems((current) => ({ ...current, title: undefined }));
                }}
                value={values.title}
              />
            </ShimmerOver>
          </FormField>
          <SuggestionChips
            fieldToFocus={fieldLabelled(t("bookmarks.modal.title.label"))}
            items={offer?.title === undefined ? [] : [offer.title]}
            label={t("bookmarks.modal.suggest.chips.title")}
            onAccept={() => {
              setValues(acceptTitle);
              setProblems((current) => ({ ...current, title: undefined }));
            }}
            pending={false}
          />
          <SlugFields
            bookmarkId={bookmark?.id}
            disabled={busy}
            forwarding={values.forwarding}
            onForwardingChange={(forwarding) => {
              change({ forwarding });
            }}
            onSlugChange={(slug) => {
              change({ slug, forwarding: forwardingAfter(values, slug) });
              setProblems((current) => ({ ...current, slug: undefined }));
            }}
            problem={slugError}
            shimmer={suggester.running && values.slug === ""}
            slug={values.slug}
            suggestion={
              <SuggestionChips
                fieldToFocus={fieldLabelled(t("bookmarks.modal.slug.label"))}
                items={offer?.slug === undefined ? [] : [offer.slug]}
                label={t("bookmarks.modal.suggest.chips.slug")}
                onAccept={() => {
                  setValues(acceptSlug);
                  setProblems((current) => ({ ...current, slug: undefined }));
                }}
                pending={false}
              />
            }
          />
          <FolderPick
            disabled={busy}
            known={bookmark?.folders ?? []}
            onChange={(folderIds) => {
              change({ folderIds });
            }}
            onCreated={(folder) => {
              setValues((current) => ({ ...current, folderIds: [...current.folderIds, folder.id] }));
              setFailure(undefined);
            }}
            value={values.folderIds}
          />
          <TagPick
            disabled={busy}
            error={tagsError}
            ids={values.tagIds}
            known={bookmark?.tags ?? []}
            names={values.tagNames}
            onChange={(tagIds, tagNames) => {
              change({ tagIds, tagNames });
              setProblems((current) => ({ ...current, tagNames: undefined }));
            }}
            onTooLong={refuseTagName}
          />
          <SuggestionChips
            fieldToFocus={fieldLabelled(t("bookmarks.modal.tags.label"))}
            items={offeredTags(values, allTags.tags)}
            label={t("bookmarks.modal.suggest.chips.tags")}
            onAccept={(name) => {
              setValues((current) => acceptTag(current, name, allTags.tags));
              setProblems((current) => ({ ...current, tagNames: undefined }));
            }}
            pending={suggester.running && values.tagIds.length === 0 && values.tagNames.length === 0}
          />
          <Disclosure defaultOpen={initial.description !== "" || problems.description !== undefined} label={t("bookmarks.modal.more")}>
            <TextareaField
              counter={t("bookmarks.modal.description.counter", { count: values.description.length, max: BOOKMARK_DESCRIPTION_MAX_LENGTH })}
              disabled={busy}
              error={descriptionError}
              label={t("bookmarks.modal.description.label")}
              maxLength={BOOKMARK_DESCRIPTION_MAX_LENGTH}
              name="description"
              onChange={(description) => {
                change({ description, descriptionOwned: true });
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
          {bookmark !== undefined && owned ? (
            <SharingSummary
              bookmarkId={bookmark.id}
              onManage={() => {
                setSharing(true);
              }}
            />
          ) : null}
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
        {sharing && shareSubject !== undefined ? (
          <ShareDialog
            onClose={() => {
              setSharing(false);
            }}
            subject={shareSubject}
          />
        ) : null}
      </FormOverlay>
      <UnsavedGuard
        description={t("bookmarks.modal.unsaved.description")}
        discardLabel={t("bookmarks.modal.unsaved.discard")}
        finalFocus={discardFinalFocus}
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
