import type { ComponentTypes } from "@slugbase/contracts";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ME_QUERY_KEY, meQuery } from "../account/me.ts";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { useConfig } from "../config/config-context.tsx";
import { ENTITLEMENTS_QUERY_KEY, entitlementsQuery } from "../entitlements/index.ts";
import { WORKSPACE_QUERY_KEY, workspaceQuery } from "../shell/workspace.ts";
import { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_TITLE_MAX_LENGTH, isValidSlug, slugAvailabilityQuery } from "./bookmarks.ts";

export type AiSuggestion = ComponentTypes["schemas"]["AiSuggestion"];

/** How long the form waits for an answer: the server gives the provider five seconds, and this leaves the rest for the network. */
export const SUGGEST_TIMEOUT_MS = 10_000;

/** The fields a save can name as taken from a suggestion (`aiFields` of the create and update operations). */
export type AiField = "title" | "slug" | "tags";

/**
 * What the Suggest action shows: nothing, a reserved row while it is not yet known whether it is offered, the upgrade slot where the plan lacks it,
 * or the action with the provider that processes the request.
 */
export type AiAvailability =
  | { readonly kind: "off" }
  | { readonly kind: "pending" }
  | { readonly kind: "upgrade" }
  | { readonly kind: "ready"; readonly provider: string | undefined };

/**
 * Whether the Suggest action is offered (doc 02 section 14): the instance has an AI adapter, the member has not opted out, the workspace holds
 * `ai.suggestions` and has the toggle on. The account, the entitlements and the workspace are each read again when the form opens and when the window
 * regains focus, so an opt-out, a plan or a toggle changed elsewhere shows without a reload, and each decides the control only while its last read
 * succeeded: an answer that is not in, is not from this visit or failed offers nothing, not the action and not the upgrade hint. The server decides
 * every one of them again on the request. While the reads of this visit are still on their way and the instance has an AI adapter the answer is
 * `pending`, which holds the room the action takes so that the fields do not move when it appears.
 */
export function useAiAvailability(): AiAvailability {
  const api = useRouter().options.context.api;
  const { features } = useConfig();
  const configured = features.ai;
  // The answers of these reads count as stale at once, here only (the other readers of them keep their own rule), so the form reads each again when it
  // opens, when the key of the entitlements arrives and when the window regains focus.
  const me = useQuery({ ...meQuery(api), staleTime: 0, refetchOnWindowFocus: "always", enabled: configured });
  const account = me.isFetchedAfterMount && !me.isError ? me.data : undefined;
  const workspaceId = account?.activeWorkspaceId ?? undefined;
  const optedOut = account?.account.aiOptOut ?? true;
  const entitlements = useQuery({
    ...entitlementsQuery(api, workspaceId ?? ""),
    staleTime: 0,
    enabled: configured && workspaceId !== undefined && !optedOut,
  });
  const entitled = entitlements.isFetchedAfterMount && !entitlements.isError ? entitlements.data?.entitlements["ai.suggestions"] : undefined;
  // Members cannot read the workspace settings, so the toggle comes with the workspace.
  const workspace = useQuery({
    ...workspaceQuery(api),
    staleTime: 0,
    refetchOnWindowFocus: "always",
    enabled: configured && workspaceId !== undefined && !optedOut && entitled === true,
  });

  if (!configured) {
    return { kind: "off" };
  }
  if (!me.isFetchedAfterMount) {
    return { kind: "pending" };
  }
  if (workspaceId === undefined || optedOut) {
    return { kind: "off" };
  }
  if (!entitlements.isFetchedAfterMount) {
    return { kind: "pending" };
  }
  if (entitled === false) {
    return { kind: "upgrade" };
  }
  if (entitled !== true) {
    return { kind: "off" };
  }
  if (!workspace.isFetchedAfterMount) {
    return { kind: "pending" };
  }
  const current = workspace.data;
  if (current === undefined || workspace.isError || current.id !== workspaceId || !current.aiEnabled) {
    return { kind: "off" };
  }
  return { kind: "ready", provider: features.aiProvider };
}

/** What a request for suggestions carries: the address, the language and the page's own metadata (doc 02 section 14), and nothing else of the form. */
export interface SuggestRequest {
  readonly url: string;
  readonly locale: string;
  readonly metadata: { readonly title?: string; readonly description?: string } | undefined;
  /** The bookmark being changed, whose own slug is free to keep; none for a new one. */
  readonly bookmarkId: string | undefined;
}

/** A suggestion as the form takes it: its slug has been judged free for this member. */
export interface FormSuggestion {
  readonly url: string;
  readonly title: string;
  readonly slug: string | null;
  readonly tags: readonly string[];
}

/** The language tag the API takes: the language of the interface, `en` when it is none the grammar knows. */
export function localeOf(language: string): string {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(language) ? language : "en";
}

/** The metadata of the request: what the page said, cut to the limits of the operation; none where it said nothing. */
export function metadataOf(page: { readonly title?: string | null | undefined; readonly description?: string | null | undefined } | undefined): SuggestRequest["metadata"] {
  const title = (page?.title ?? "").trim().slice(0, BOOKMARK_TITLE_MAX_LENGTH);
  const description = (page?.description ?? "").trim().slice(0, BOOKMARK_DESCRIPTION_MAX_LENGTH);
  if (title === "" && description === "") {
    return undefined;
  }
  return { ...(title === "" ? {} : { title }), ...(description === "" ? {} : { description }) };
}

/**
 * Whether the availability check calls `slug` free. The check ends with the run: when `signal` aborts before it has answered (the run's timeout, or
 * the form dropped the run), it stops being waited for, its request is cancelled and the slug counts as not free, so a check that never answers
 * cannot keep the run, and the fields waiting on it, open. A failed check also counts as not free.
 */
async function slugIfFree(api: ApiClient, queryClient: QueryClient, slug: string, bookmarkId: string | undefined, signal: AbortSignal): Promise<boolean> {
  const options = slugAvailabilityQuery(api, slug, bookmarkId);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => {
      resolve(false);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const checked = queryClient.query(options).then(
    (availability) => availability.status === "available",
    () => false,
  );
  try {
    const free = await Promise.race([checked, aborted]);
    if (signal.aborted) {
      void queryClient.cancelQueries({ queryKey: options.queryKey });
    }
    return free;
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Asks for the suggestion and judges its slug before it is offered: the server has checked the grammar and the member's own slugs when it answered, and
 * an answer from the cache may be older than a slug the member has taken since, so the availability is read again and a slug that is not free, or whose
 * check failed, is left out.
 */
async function ask(api: ApiClient, queryClient: QueryClient, request: SuggestRequest, signal: AbortSignal): Promise<FormSuggestion> {
  const { data, error } = await api.POST("/api/v1/ai/suggestions", {
    body: { url: request.url, locale: request.locale, ...(request.metadata === undefined ? {} : { metadata: request.metadata }) },
    signal,
  });
  if (data === undefined) {
    throw new Error("The suggestion request did not answer with a document", { cause: error });
  }
  let slug: string | null = null;
  if (data.slug !== null && isValidSlug(data.slug)) {
    slug = (await slugIfFree(api, queryClient, data.slug, request.bookmarkId, signal)) ? data.slug : null;
  }
  return { url: request.url, title: data.title, slug, tags: data.tags };
}

interface Run {
  readonly url: string;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface AiSuggester {
  /** Whether a request is running. */
  readonly running: boolean;
  /** Whether the last request ended without a suggestion, which the form tells in a small note. */
  readonly failed: boolean;
  /** Whether the API refused the member the action (the toggle, the opt-out, the plan or the adapter changed since the form read them), so the form stops offering it. */
  readonly refused: boolean;
  /** Asks for the suggestion and hands it to `onSuggestion`, unless the request was dropped meanwhile. */
  readonly run: (request: SuggestRequest, onSuggestion: (suggestion: FormSuggestion) => void) => void;
  /** Tells that the address is now `url`: a request for another address is dropped, and so is the note of one. */
  readonly follow: (url: string) => void;
  /** Drops the request that is running. */
  readonly cancel: () => void;
}

/**
 * The suggestion requests of the bookmark form. One request runs at a time and an answer that is not the current request's (it was dropped, the
 * address changed, the form closed or the member saved) never reaches the form. Every failure leaves the fields as they are: a timeout, a provider
 * error, a rate limit and a network error are told in a note, and a refusal (`403`, or `503 ai_unavailable`) also withdraws the action and reads
 * the settings it depends on again.
 */
export function useAiSuggester(api: ApiClient): AiSuggester {
  const queryClient = useQueryClient();
  const running = useRef<Run | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState(false);

  const cancel = useCallback((): void => {
    const run = running.current;
    if (run !== undefined) {
      clearTimeout(run.timer);
      run.controller.abort();
    }
    running.current = undefined;
    setPending(false);
  }, []);

  const follow = useCallback(
    (url: string): void => {
      if (running.current !== undefined && running.current.url !== url) {
        cancel();
      }
      setFailed(false);
    },
    [cancel],
  );

  const run = useCallback(
    (request: SuggestRequest, onSuggestion: (suggestion: FormSuggestion) => void): void => {
      cancel();
      const current: Run = { url: request.url, controller: new AbortController(), timer: undefined };
      running.current = current;
      setPending(true);
      setFailed(false);
      current.timer = setTimeout(() => {
        current.controller.abort();
      }, SUGGEST_TIMEOUT_MS);
      const finish = (): boolean => {
        if (running.current !== current) {
          return false;
        }
        clearTimeout(current.timer);
        running.current = undefined;
        setPending(false);
        return true;
      };
      ask(api, queryClient, request, current.controller.signal).then(
        (suggestion) => {
          if (finish()) {
            onSuggestion(suggestion);
          }
        },
        (error: unknown) => {
          if (!finish() || isSessionEnded(error)) {
            return;
          }
          setFailed(true);
          if (error instanceof ApiProblemError && (error.status === 403 || error.code === "ai_unavailable")) {
            setRefused(true);
            void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY });
          }
        },
      );
    },
    [api, queryClient, cancel],
  );

  useEffect(
    () => () => {
      cancel();
    },
    [cancel],
  );

  return { running: pending, failed, refused, run, follow, cancel };
}

/** A tag taken from a suggestion: the member's tag of that name when the list has one, else the name, which the save makes a tag of. */
export interface SourcedTag {
  readonly id: string | undefined;
  readonly name: string;
}

/** What the form knows of the suggestions: the chips still on offer, and the values taken from a suggestion that the save counts if they stand. */
export interface AiState {
  readonly offer: { readonly title: string | undefined; readonly slug: string | undefined; readonly tags: readonly string[] } | undefined;
  readonly sourced: { readonly title: string | undefined; readonly slug: string | undefined; readonly tags: readonly SourcedTag[] };
}

export const NO_AI_STATE: AiState = { offer: undefined, sourced: { title: undefined, slug: undefined, tags: [] } };

/** The part of the form values the suggestions read and change. */
export interface Suggestible {
  readonly url: string;
  readonly title: string;
  readonly titleOwned: boolean;
  readonly slug: string;
  readonly forwarding: boolean;
  readonly tagIds: readonly string[];
  readonly tagNames: readonly string[];
  readonly ai: AiState;
}

export interface KnownTag {
  readonly id: string;
  readonly name: string;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sourcedTagOf(name: string, known: readonly KnownTag[]): SourcedTag {
  return { id: known.find((tag) => sameName(tag.name, name))?.id, name };
}

function addTag<V extends Suggestible>(values: V, tag: SourcedTag): V {
  if (tag.id !== undefined) {
    return values.tagIds.includes(tag.id) ? values : { ...values, tagIds: [...values.tagIds, tag.id] };
  }
  return values.tagNames.some((name) => sameName(name, tag.name)) ? values : { ...values, tagNames: [...values.tagNames, tag.name] };
}

function isChosen(values: Suggestible, tag: SourcedTag): boolean {
  return tag.id === undefined ? values.tagNames.some((name) => sameName(name, tag.name)) : values.tagIds.includes(tag.id);
}

/** A slug turns forwarding on when the form had none, as typing one does. */
function slugged<V extends Suggestible>(values: V, slug: string): V {
  return { ...values, slug, forwarding: values.slug === "" ? true : values.forwarding };
}

/**
 * Puts a suggestion into the form (doc 02 section 14): a field that is empty is filled, and one that holds a value, whoever put it there, is left
 * alone and gets a chip when the suggestion differs. A suggestion for another address than the form holds now is dropped. `known` is the member's
 * tag list: a suggested name that is one of their tags is chosen as that tag.
 */
export function applySuggestion<V extends Suggestible>(values: V, suggestion: FormSuggestion, known: readonly KnownTag[]): V {
  if (values.url.trim() !== suggestion.url) {
    return values;
  }
  let next = values;
  let { title: titleSource, slug: slugSource, tags: tagSources } = values.ai.sourced;
  let titleOffer: string | undefined;
  let slugOffer: string | undefined;
  const title = suggestion.title.trim();
  if (title !== "") {
    if (values.title.trim() === "") {
      next = { ...next, title, titleOwned: true };
      titleSource = title;
    } else if (values.title.trim() !== title) {
      titleOffer = title;
    }
  }
  if (suggestion.slug !== null) {
    if (values.slug === "") {
      next = slugged(next, suggestion.slug);
      slugSource = suggestion.slug;
    } else if (values.slug !== suggestion.slug) {
      slugOffer = suggestion.slug;
    }
  }
  const tagOffers: string[] = [];
  const nothingChosen = values.tagIds.length === 0 && values.tagNames.length === 0;
  for (const name of suggestion.tags) {
    const tag = sourcedTagOf(name, known);
    if (nothingChosen) {
      next = addTag(next, tag);
      tagSources = [...tagSources.filter((source) => !isSameSource(source, tag)), tag];
    } else if (!isChosen(values, tag)) {
      tagOffers.push(name);
    }
  }
  const offered = titleOffer !== undefined || slugOffer !== undefined || tagOffers.length > 0;
  return {
    ...next,
    ai: {
      offer: offered ? { title: titleOffer, slug: slugOffer, tags: tagOffers } : undefined,
      sourced: { title: titleSource, slug: slugSource, tags: tagSources },
    },
  };
}

function isSameSource(a: SourcedTag, b: SourcedTag): boolean {
  return a.id !== undefined || b.id !== undefined ? a.id === b.id : sameName(a.name, b.name);
}

function withoutOffer(ai: AiState, change: { title?: true; slug?: true; tag?: string }): AiState["offer"] {
  const offer = ai.offer;
  if (offer === undefined) {
    return undefined;
  }
  const next = {
    title: change.title === true ? undefined : offer.title,
    slug: change.slug === true ? undefined : offer.slug,
    tags: change.tag === undefined ? offer.tags : offer.tags.filter((name) => name !== change.tag),
  };
  return next.title === undefined && next.slug === undefined && next.tags.length === 0 ? undefined : next;
}

/** Takes the offered title: it replaces the title and counts as taken from the suggestion for as long as it stands. */
export function acceptTitle<V extends Suggestible>(values: V): V {
  const title = values.ai.offer?.title;
  if (title === undefined) {
    return values;
  }
  return { ...values, title, titleOwned: true, ai: { offer: withoutOffer(values.ai, { title: true }), sourced: { ...values.ai.sourced, title } } };
}

/** Takes the offered slug in place of the one the form holds. */
export function acceptSlug<V extends Suggestible>(values: V): V {
  const slug = values.ai.offer?.slug;
  if (slug === undefined) {
    return values;
  }
  return { ...slugged(values, slug), ai: { offer: withoutOffer(values.ai, { slug: true }), sourced: { ...values.ai.sourced, slug } } };
}

/** Adds the offered tag `name` to the tags chosen. */
export function acceptTag<V extends Suggestible>(values: V, name: string, known: readonly KnownTag[]): V {
  const tag = sourcedTagOf(name, known);
  const added = addTag(values, tag);
  return { ...added, ai: { offer: withoutOffer(values.ai, { tag: name }), sourced: { ...values.ai.sourced, tags: [...values.ai.sourced.tags.filter((source) => !isSameSource(source, tag)), tag] } } };
}

/** The tag chips still worth offering: those the form does not already have. */
export function offeredTags(values: Suggestible, known: readonly KnownTag[]): string[] {
  return (values.ai.offer?.tags ?? []).filter((name) => !isChosen(values, sourcedTagOf(name, known)));
}

/**
 * The fields the save names as taken from a suggestion (doc 02 section 14): those whose value is still the one that came from it. A field the member
 * changed after taking it is theirs and is not named, and neither is a tag they took off again. `only` limits the answer to the fields a change sends.
 */
export function aiFieldsOf(values: Suggestible, only?: readonly AiField[]): AiField[] {
  const { sourced } = values.ai;
  const fields: AiField[] = [];
  if (sourced.title !== undefined && values.title.trim() === sourced.title) {
    fields.push("title");
  }
  if (sourced.slug !== undefined && values.slug === sourced.slug) {
    fields.push("slug");
  }
  if (sourced.tags.some((tag) => isChosen(values, tag))) {
    fields.push("tags");
  }
  return only === undefined ? fields : fields.filter((field) => only.includes(field));
}
