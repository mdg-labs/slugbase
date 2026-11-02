import { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_TITLE_MAX_LENGTH, BOOKMARK_URL_MAX_LENGTH, FOLDER_NAME_MAX_LENGTH, TAG_NAME_MAX_LENGTH, type ImportFileBookmark, type ImportRequest, type ImportResult } from "@slugbase/contracts";
import { normalizeBookmarkUrl, type BookmarkUrlRefusal } from "../bookmarks/url.ts";
import type { EntitlementLimit } from "../entitlements/catalog.ts";
import { cleanText } from "./text.ts";

// The preview of a SlugBase JSON import (doc 02 section 13.1, doc 04 section 10.9, doc 10 T13): what an import of the file would do, answered without writing anything. The file has passed the
// contract's strict schemas, so its shape is known and its depth is bounded; what is left to judge here is each bookmark's content, which is untrusted: its URL goes through the bookmark URL
// module (http and https only), its text is made plain text and cut to its limit, and a bookmark that cannot be imported is reported and never fails the others. Bookmarks are judged in the order of the
// file: a duplicate is judged before the room the workspace has left, and the room is spent in that order.
//
// The room is `bookmarks.max - bookmark_count`, the counter of the workspace's row and never a count of its bookmarks (doc 01 section 7.5); a plan-archived flag in the file is not read, so it
// can neither change the count nor make a bookmark a duplicate. A duplicate is a bookmark whose canonical URL the caller has on a bookmark that is not plan-archived already, or an earlier
// bookmark of the file has.

/** What the preview reads of the database, in the transaction of the request. */
export interface ImportPreviewStore {
  /** `workspaces.bookmark_count` of the workspace of the transaction; undefined when the workspace cannot be read. */
  bookmarkCount(): Promise<number | undefined>;
  /** Those of `canonicals` that the caller has on a bookmark of the workspace that is not plan-archived. */
  existingCanonicalUrls(canonicals: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ImportPreviewDependencies {
  readonly store: ImportPreviewStore;
}

export interface ImportPreviewAsk {
  readonly file: ImportRequest;
  /** True skips a bookmark that is a duplicate; false imports it. */
  readonly skipDuplicates: boolean;
  /** The workspace's `bookmarks.max`. */
  readonly ceiling: EntitlementLimit;
}

export type ImportPreviewOutcome =
  /** The workspace cannot be read: it is being deleted, or the caller is no member of it. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "previewed"; readonly result: ImportResult };

/** A bookmark of the file whose URL is one a bookmark can have, with its text made plain and cut to its limits. */
export interface ImportBookmark {
  /** The place in the file, counted from 1. */
  readonly position: number;
  /** The URL as stored. */
  readonly url: string;
  /** The canonical form of the URL: the key of duplicate detection. */
  readonly canonical: string;
  /** The host of the URL, lower case and in punycode. */
  readonly host: string;
  /** The title; the host of the URL when the file gives none. */
  readonly title: string;
  readonly description: string | null;
  /** Whether the file has the bookmark pinned. */
  readonly pinned: boolean;
}

/** A bookmark of the file whose URL is refused. */
export interface ImportRefusal {
  readonly position: number;
  /** The title the file gives, plain and cut; empty when it gives none. */
  readonly title: string;
  /** The URL the file gives, plain and cut to the longest URL a bookmark holds. */
  readonly url: string;
  readonly reason: ImportRefusalReason;
}

export type ImportRefusalReason = "url_not_allowed" | "url_invalid";

const REFUSALS: Readonly<Record<BookmarkUrlRefusal, ImportRefusalReason>> = {
  empty: "url_invalid",
  too_long: "url_invalid",
  malformed: "url_invalid",
  not_http: "url_not_allowed",
};

/** The bookmarks of a file, whether it is an export document or a plain array. */
export function bookmarksOfFile(file: ImportRequest): readonly ImportFileBookmark[] {
  return Array.isArray(file) ? file : file.bookmarks;
}

/** Reads one bookmark of the file: its normalised form, or the reason its URL is refused. */
export function readImportBookmark(entry: ImportFileBookmark, position: number): ImportBookmark | ImportRefusal {
  const title = cleanText(entry.title ?? "", BOOKMARK_TITLE_MAX_LENGTH);
  const parsed = normalizeBookmarkUrl(entry.url);
  if (!parsed.ok) {
    return { position, title, url: cleanText(entry.url, BOOKMARK_URL_MAX_LENGTH), reason: REFUSALS[parsed.reason] };
  }
  const description = cleanText(entry.description ?? "", BOOKMARK_DESCRIPTION_MAX_LENGTH);
  return {
    position,
    url: parsed.value.url,
    canonical: parsed.value.canonical,
    host: parsed.value.host,
    title: title === "" ? cleanText(parsed.value.host, BOOKMARK_TITLE_MAX_LENGTH) : title,
    description: description === "" ? null : description,
    pinned: entry.pinned === true,
  };
}

export function isRefusal(read: ImportBookmark | ImportRefusal): read is ImportRefusal {
  return "reason" in read;
}

/** The distinct names, compared without regard to case, once each is plain text cut to `max`; a name that is blank is none. */
function distinctNames(names: Iterable<string>, max: number): number {
  const seen = new Set<string>();
  for (const name of names) {
    const clean = cleanText(name, max);
    if (clean !== "") {
      seen.add(clean.toLowerCase());
    }
  }
  return seen.size;
}

function* folderNamesOf(file: ImportRequest): Generator<string> {
  if (!Array.isArray(file)) {
    for (const folder of file.folders ?? []) {
      yield folder.name;
    }
  }
  for (const entry of bookmarksOfFile(file)) {
    yield* entry.folders ?? [];
  }
}

function* tagNamesOf(file: ImportRequest): Generator<string> {
  if (!Array.isArray(file)) {
    yield* file.tags ?? [];
  }
  for (const entry of bookmarksOfFile(file)) {
    yield* entry.tags ?? [];
  }
}

export function entry(read: ImportBookmark | ImportRefusal): { position: number; title: string; url: string } {
  return { position: read.position, title: read.title, url: read.url };
}

/** What the file holds: its bookmarks, and its distinct folder and tag names. */
export function detectedOf(file: ImportRequest, bookmarks: number): ImportResult["detected"] {
  return { bookmarks, folders: distinctNames(folderNamesOf(file), FOLDER_NAME_MAX_LENGTH), tags: distinctNames(tagNamesOf(file), TAG_NAME_MAX_LENGTH) };
}

/**
 * What an import of the file would do, and nothing written. The room under the workspace's ceiling is read from its counter in the same
 * transaction; a ceiling of `unlimited` leaves no limit.
 */
export async function previewImport({ store }: ImportPreviewDependencies, ask: ImportPreviewAsk): Promise<ImportPreviewOutcome> {
  const used = await store.bookmarkCount();
  if (used === undefined) {
    return { kind: "unavailable" };
  }
  const reads = bookmarksOfFile(ask.file).map((bookmark, index) => readImportBookmark(bookmark, index + 1));
  const canonicals = [...new Set(reads.flatMap((read) => (isRefusal(read) ? [] : [read.canonical])))];
  const existing = ask.skipDuplicates && canonicals.length > 0 ? await store.existingCanonicalUrls(canonicals) : new Set<string>();

  let room = ask.ceiling === "unlimited" ? Number.POSITIVE_INFINITY : Math.max(0, ask.ceiling - used);
  let created = 0;
  const seen = new Set<string>();
  const skipped: ImportResult["skipped"] = [];
  const failed: ImportResult["failed"] = [];
  for (const read of reads) {
    if (isRefusal(read)) {
      failed.push({ ...entry(read), reason: read.reason });
      continue;
    }
    const duplicate = ask.skipDuplicates && (existing.has(read.canonical) || seen.has(read.canonical));
    seen.add(read.canonical);
    if (duplicate) {
      skipped.push({ ...entry(read), reason: "duplicate" });
    } else if (room > 0) {
      room -= 1;
      created += 1;
    } else {
      skipped.push({ ...entry(read), reason: "bookmark_limit_reached" });
    }
  }
  return {
    kind: "previewed",
    result: {
      detected: detectedOf(ask.file, reads.length),
      created,
      skipped,
      failed,
      slugsDropped: 0,
      droppedSlugs: [],
      foldersCreated: 0,
      tagsCreated: 0,
    },
  };
}
