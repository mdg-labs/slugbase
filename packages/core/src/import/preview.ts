import {
  BOOKMARK_DESCRIPTION_MAX_LENGTH,
  BOOKMARK_TITLE_MAX_LENGTH,
  BOOKMARK_URL_MAX_LENGTH,
  FOLDER_COLOR_MAX,
  FOLDER_COLOR_MIN,
  FOLDER_DEFAULT_COLOR,
  FOLDER_DEFAULT_ICON,
  FOLDER_ICONS,
  FOLDER_NAME_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
  type ImportFileBookmark,
  type ImportRequest,
  type ImportResult,
} from "@slugbase/contracts";
import { normalizeBookmarkUrl, type BookmarkUrlRefusal } from "../bookmarks/url.ts";
import type { EntitlementLimit } from "../entitlements/catalog.ts";
import { parseSlug } from "../go/slug.ts";
import { cleanText } from "./text.ts";

// The preview of a SlugBase JSON import (doc 02 section 13.1, doc 04 section 10.9, doc 10 T13): what an import of the file would do, answered without writing anything. The file has passed the
// contract's strict schemas, so its shape is known and its depth is bounded; what is left to judge here is each bookmark's content, which is untrusted: its URL goes through the bookmark URL
// module (http and https only), its text is made plain text and cut to its limit, and a bookmark that cannot be imported is reported and never fails the others. Bookmarks are judged in the order of the
// file: a duplicate is judged before the room the workspace has left, and the room is spent in that order.
//
// The room is `bookmarks.max - bookmark_count`, the counter of the workspace's row and never a count of its bookmarks (doc 01 section 7.5); a plan-archived flag in the file is not read, so it
// can neither change the count nor make a bookmark a duplicate. A duplicate is a bookmark whose canonical URL the caller has on a bookmark that is not plan-archived already, or an earlier
// bookmark of the file has.
//
// The preview also says what the import does with the file's folders, tags and slugs (doc 02 section 13.1, Q30), judged by the rules the import applies (`planSlugs`, `planNames`). A folder or a tag
// is matched by its name without regard to case, and one the caller has not is created; a name is plain text cut to its limit and a name that is empty then is none. Which spellings are one name is the database's to say (`ImportPreviewStore.firstSameNames`, the comparison of its `citext` columns), for the preview and for the import alike, so the two cannot disagree on any
// database: the file's names are never folded here. A slug is kept by a bookmark that is imported when it is
// in the grammar, the caller has no bookmark with it, plan-archived or not, and no earlier bookmark that is imported has it; any other slug is dropped from its bookmark with forwarding off, and the bookmark is imported.

/** What the preview reads of the database, in the transaction of the request. */
export interface ImportPreviewStore {
  /** `workspaces.bookmark_count` of the workspace of the transaction; undefined when the workspace cannot be read. */
  bookmarkCount(): Promise<number | undefined>;
  /** Those of `canonicals` that the caller has on a bookmark of the workspace that is not plan-archived. */
  existingCanonicalUrls(canonicals: readonly string[]): Promise<ReadonlySet<string>>;
  /** Those of `slugs` that the caller has on a bookmark of the workspace, plan-archived or not. */
  existingSlugs(slugs: readonly string[]): Promise<ReadonlySet<string>>;
  /** Those of `names`, as they were asked, that match a folder the caller has, without regard to case. */
  existingFolderNames(names: readonly string[]): Promise<ReadonlySet<string>>;
  /** Those of `names`, as they were asked, that match a tag the caller has, without regard to case. */
  existingTagNames(names: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * For each of `names`, the place in `names` of the first one that the database compares as the same folder or tag name (the comparison of its `citext` columns): the answer for the first spelling of a name is its own place, and
   * for any other spelling the place of an earlier one. It reads nothing of anyone.
   */
  firstSameNames(names: readonly string[]): Promise<readonly number[]>;
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
  /** The slug the file gives: none, one in the grammar (in its normal form), or text outside it. */
  readonly slug: { readonly kind: "none" } | { readonly kind: "valid"; readonly slug: string } | { readonly kind: "invalid"; readonly text: string };
  /** Whether the file has /go forward to the bookmark; it takes effect only with a slug the bookmark keeps. */
  readonly forwarding: boolean;
  /** The names of the folders the file files the bookmark in: plain, cut, not empty, each spelling once. */
  readonly folders: readonly string[];
  /** The names of the tags the file gives the bookmark, by the same rules. */
  readonly tags: readonly string[];
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

/** The names as plain text cut to `max`, without the empty ones and without a spelling repeated; the order of the file stands. Whether two spellings are one name is not decided here (`namesOf`). */
function cleanNames(names: readonly string[] | undefined, max: number): string[] {
  return [...new Set((names ?? []).map((name) => cleanText(name, max)).filter((name) => name !== ""))];
}

function readSlug(slug: string | null | undefined): ImportBookmark["slug"] {
  if (slug === null || slug === undefined || slug.trim() === "") {
    return { kind: "none" };
  }
  const parsed = parseSlug(slug);
  return parsed === undefined ? { kind: "invalid", text: cleanText(slug, BOOKMARK_URL_MAX_LENGTH) } : { kind: "valid", slug: parsed };
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
    slug: readSlug(entry.slug),
    forwarding: entry.forwarding === true,
    folders: cleanNames(entry.folders, FOLDER_NAME_MAX_LENGTH),
    tags: cleanNames(entry.tags, TAG_NAME_MAX_LENGTH),
  };
}

export function isRefusal(read: ImportBookmark | ImportRefusal): read is ImportRefusal {
  return "reason" in read;
}

export function entry(read: ImportBookmark | ImportRefusal): { position: number; title: string; url: string } {
  return { position: read.position, title: read.title, url: read.url };
}

/** A folder the import makes sure the caller has. */
export interface WantedFolder {
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

function iconOf(icon: string | undefined): string {
  return icon !== undefined && (FOLDER_ICONS as readonly string[]).includes(icon) ? icon : FOLDER_DEFAULT_ICON;
}

function colorOf(color: number | undefined): number {
  return color !== undefined && color >= FOLDER_COLOR_MIN && color <= FOLDER_COLOR_MAX ? color : FOLDER_DEFAULT_COLOR;
}

/** The names of one kind that the import deals with. */
interface NameSet {
  /** The names the import makes sure the caller has, one for each name the database tells apart, the first spelling standing. */
  readonly wanted: readonly string[];
  /** The wanted spelling of each spelling of a wanted name. */
  readonly spelledAs: ReadonlyMap<string, string>;
  /** The names of the file the database tells apart. */
  readonly distinct: number;
}

/**
 * Asks the database which of the file's spellings are one name. `listed` (the names of the document's lists) and `used` (those of the bookmarks that are created) are the names to make sure of, in that order, and `rest` the names
 * of the whole file, which only the count of its distinct names reads. Each spelling is asked once, in that order, so the first spelling of a name is the one of the document's list if it has one, and the store is not asked when there is none.
 */
async function nameSet(store: ImportPreviewStore, listed: readonly string[], used: readonly string[], rest: readonly string[]): Promise<NameSet> {
  const wantedSpellings = [...new Set([...listed, ...used])];
  const spellings = [...new Set([...wantedSpellings, ...rest])];
  if (spellings.length === 0) {
    return { wanted: [], spelledAs: new Map(), distinct: 0 };
  }
  const first = await store.firstSameNames(spellings);
  if (first.length !== spellings.length || first.some((place, index) => !Number.isInteger(place) || place < 0 || place > index || first[place] !== place)) {
    throw new Error("the store did not answer which names are the same");
  }
  const spelledAs = new Map<string, string>();
  const wanted: string[] = [];
  spellings.forEach((spelling, index) => {
    const place = first[index] ?? index;
    if (place < wantedSpellings.length) {
      spelledAs.set(spelling, spellings[place] ?? spelling);
      if (place === index) {
        wanted.push(spelling);
      }
    }
  });
  return { wanted, spelledAs, distinct: first.filter((place, index) => place === index).length };
}

/** What the import does with the names of the file's folders and tags. */
export interface NamePlan {
  /** The folders the import makes sure the caller has: those the file lists, with their icon and colour (an icon outside the list a folder may carry and a colour outside 1 to 8 become the defaults), then those of the bookmarks that are created. */
  readonly folders: readonly WantedFolder[];
  /** The tags the import makes sure the caller has, by the same rules. */
  readonly tags: readonly string[];
  /** The wanted folder a spelling of a folder name of a created bookmark stands for. */
  readonly folderOf: ReadonlyMap<string, string>;
  /** The wanted tag a spelling of a tag name of a created bookmark stands for. */
  readonly tagOf: ReadonlyMap<string, string>;
  /** The distinct folder and tag names of the whole file. */
  readonly detected: { readonly folders: number; readonly tags: number };
}

/**
 * The folders and tags the import makes sure the caller has, one for each name the database tells apart (`firstSameNames`), the first spelling standing: those the file lists, then those of the bookmarks that are created. A name is plain text cut
 * to its limit and an empty one is none; a name is not split at a slash. Preview and import ask the store the same questions, so they count alike.
 */
export async function planNames(store: ImportPreviewStore, file: ImportRequest, created: readonly ImportBookmark[]): Promise<NamePlan> {
  const listedFolders = new Map<string, WantedFolder>();
  for (const folder of Array.isArray(file) ? [] : (file.folders ?? [])) {
    const name = cleanText(folder.name, FOLDER_NAME_MAX_LENGTH);
    if (name !== "" && !listedFolders.has(name)) {
      listedFolders.set(name, { name, icon: iconOf(folder.icon), color: colorOf(folder.color) });
    }
  }
  const listedTags = [...new Set((Array.isArray(file) ? [] : (file.tags ?? [])).map((tag) => cleanText(tag, TAG_NAME_MAX_LENGTH)).filter((tag) => tag !== ""))];
  const entries = bookmarksOfFile(file);
  const folders = await nameSet(
    store,
    [...listedFolders.keys()],
    created.flatMap((bookmark) => bookmark.folders),
    entries.flatMap((entry) => cleanNames(entry.folders, FOLDER_NAME_MAX_LENGTH)),
  );
  const tags = await nameSet(
    store,
    listedTags,
    created.flatMap((bookmark) => bookmark.tags),
    entries.flatMap((entry) => cleanNames(entry.tags, TAG_NAME_MAX_LENGTH)),
  );
  return {
    folders: folders.wanted.map((name) => listedFolders.get(name) ?? { name, icon: FOLDER_DEFAULT_ICON, color: FOLDER_DEFAULT_COLOR }),
    tags: tags.wanted,
    folderOf: folders.spelledAs,
    tagOf: tags.spelledAs,
    detected: { folders: folders.distinct, tags: tags.distinct },
  };
}

/** What the bookmarks that are created do with their slugs. */
export interface SlugPlan {
  /** The slug each bookmark keeps, by its position in the file. */
  readonly kept: ReadonlyMap<number, string>;
  /** The slugs that are dropped, in the order of the file. */
  readonly dropped: ImportResult["droppedSlugs"];
}

/** The slugs of `created` that are in the grammar, each once: the ones to ask the store about. */
export function slugsToCheck(created: readonly ImportBookmark[]): string[] {
  return [...new Set(created.flatMap((bookmark) => (bookmark.slug.kind === "valid" ? [bookmark.slug.slug] : [])))];
}

/**
 * Decides which slug each bookmark of `created` (in the order of the file) keeps: one in the grammar that is not in `existing` (the slugs the caller has) and that no earlier bookmark of `created` keeps. Every other slug is
 * dropped, from its bookmark alone: outside the grammar is `slug_invalid`, held already is `slug_conflict`. A bookmark that is not created holds no slug, so it takes none from a later bookmark.
 */
export function planSlugs(created: readonly ImportBookmark[], existing: ReadonlySet<string>): SlugPlan {
  const kept = new Map<number, string>();
  const dropped: ImportResult["droppedSlugs"] = [];
  const claimed = new Set<string>();
  for (const bookmark of created) {
    if (bookmark.slug.kind === "none") {
      continue;
    }
    if (bookmark.slug.kind === "invalid") {
      dropped.push({ ...entry(bookmark), slug: bookmark.slug.text, reason: "slug_invalid" });
    } else if (existing.has(bookmark.slug.slug) || claimed.has(bookmark.slug.slug)) {
      dropped.push({ ...entry(bookmark), slug: bookmark.slug.slug, reason: "slug_conflict" });
    } else {
      claimed.add(bookmark.slug.slug);
      kept.set(bookmark.position, bookmark.slug.slug);
    }
  }
  return { kept, dropped };
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
  const created: ImportBookmark[] = [];
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
      created.push(read);
    } else {
      skipped.push({ ...entry(read), reason: "bookmark_limit_reached" });
    }
  }
  const slugs = slugsToCheck(created);
  const plan = planSlugs(created, slugs.length > 0 ? await store.existingSlugs(slugs) : new Set<string>());
  const names = await planNames(store, ask.file, created);
  const existingFolders = names.folders.length > 0 ? await store.existingFolderNames(names.folders.map((folder) => folder.name)) : new Set<string>();
  const existingTags = names.tags.length > 0 ? await store.existingTagNames(names.tags) : new Set<string>();
  return {
    kind: "previewed",
    result: {
      detected: { bookmarks: reads.length, ...names.detected },
      created: created.length,
      skipped,
      failed,
      slugsDropped: plan.dropped.length,
      droppedSlugs: plan.dropped,
      foldersCreated: names.folders.filter((folder) => !existingFolders.has(folder.name)).length,
      tagsCreated: names.tags.filter((tag) => !existingTags.has(tag)).length,
    },
  };
}
