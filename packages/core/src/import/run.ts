import type { ImportRequest, ImportResult } from "@slugbase/contracts";
import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import type { EntitlementLimit } from "../entitlements/catalog.ts";
import type { DomainEvent } from "../events/catalog.ts";
import { parseSlug } from "../go/slug.ts";
import {
  canonicalsOf,
  entry,
  isRefusal,
  missingNames,
  overLinks,
  overNewNames,
  planPreparedNames,
  planSlugs,
  prepareImportInSlices,
  roomUnder,
  slugsToCheck,
  type ImportBookmark,
  type ImportPreviewStore,
  type ImportRefusal,
  type PreparedChoices,
  type PreparedImport,
} from "./preview.ts";

// The JSON import itself (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1, T11 and T13), in the one transaction the store and the audit writer are bound to. The file is judged exactly as the preview judges it
// (`previewImport`): each bookmark's URL goes through the bookmark URL module, its text is made plain and cut, a duplicate by canonical URL is left out unless asked otherwise, and the workspace's room is spent in the order
// of the file. What differs is the room itself: the store takes the places the file needs under the workspace's row lock and raises `bookmark_count` by the number it was given, in the same transaction that inserts the
// bookmarks, so two imports at the limit minus one together create one bookmark. The bookmarks are inserted in batches, in the order of the file, with identifiers that ascend in that order, and each is announced as
// `bookmark.created` in the same transaction. A plan-archived flag in the file is never read. The import is recorded as one `import.completed` audit event with counts only, written after the bookmarks, so a failure of
// any write (the bookmarks, the counter, the jobs or the event) rejects, and the caller's transaction, which must not commit, leaves none of them. The service never starts a transaction and swallows no failure.
//
// A file that names more than `IMPORT_MAX_DISTINCT_NAMES` distinct folder and tag spellings together is refused first (`overDistinctNames`), before the store is asked anything, as `too_many_distinct_names`, an answer of its own because it says nothing of the names the file would create.
//
// One import creates at most `IMPORT_MAX_NEW_NAMES` new folders and tags together (`missingNames`). The count is made before the places are taken, with the room the workspace's counter shows as the preview reads it, so that a
// file over the limit never takes the row lock. When the places taken then cover more bookmarks than that count assumed (the counter moved in between), the count is made again under the lock, and a file over the limit is
// answered `too_many_names` with the places taken, so the caller's transaction must not commit that outcome.
//
// One import also makes at most `IMPORT_MAX_LINKS` folder and tag links together (`overLinks`), which names the caller has do not lessen. It is decided at the same two places, after the names: before the places are taken, from the
// bookmarks the counter shows room for, and again under the lock when the places taken cover another number of bookmarks; the outcome is `too_many_links` and the caller's transaction must not commit it either.
//
// The folders and tags of the file (doc 02 section 13.1, Q30) are made sure of once the places are taken, before the first bookmark is written: the store gets or creates each by name, without regard to case, one for each name the database tells apart (`planNames`), and a
// folder or tag the caller has keeps its icon and colour. The folders and tags the file lists exist afterwards whether a bookmark uses them or not; those a bookmark names are made sure of for the bookmarks that are
// created. Each bookmark is filed and tagged by its own names, one pair for each folder or tag however many spellings of its name the bookmark has (the count of `overLinks` is the number of pairs the store gets), in the batch that writes it. A slug is kept by the bookmark that is created when `planSlugs` says so; the store inserts it only where the caller has no
// bookmark with it at that moment, and a bookmark that loses its slug to a bookmark another transaction wrote since is still created, without the slug and without forwarding, and reported with the others.

// The remembered slug choices of the file (doc 02 sections 6.4 and 13.2, doc 10 T2 and T13) are restored once every bookmark is written, in the same transaction and before the audit event, so a failure of one rolls back the
// whole import. A choice in `goPreferences` names a bookmark of the file by its `ref`, and is restored only when that ref is the ref of exactly one bookmark of the file, that bookmark was created by this import, kept the slug the
// choice names (read as a slug of a bookmark is) and forwards: a bookmark that was skipped, failed, or lost its slug to a conflict, a ref no bookmark has or more than one has, a slug outside the grammar, and a plain array of bookmarks, restore
// nothing and fail nothing. The store gets the choices as the member's own for the account and workspace of the transaction (`rememberChoices`), which applies the checks of a member's own choice, so no choice of another member or
// workspace is written. A slug is asked for once, in the order of the file, and the store is asked once for all of them, so the choices a file costs under the workspace's row lock are at most the number of bookmarks it creates with a slug, which `IMPORT_MAX_BOOKMARKS` bounds, written in batches.

/** The most bookmarks one insert statement writes. */
export const IMPORT_BATCH_SIZE = 500;

/** A bookmark the import creates. */
export interface ImportNewBookmark {
  /** A UUIDv7 generated by the caller (Q91); the identifiers of one import ascend in the order of the file. */
  readonly id: string;
  /** The member who imports it and owns it; the account of the transaction. */
  readonly ownerId: string;
  readonly url: string;
  readonly urlCanonical: string;
  readonly host: string;
  readonly title: string;
  readonly description: string | null;
  readonly pinned: boolean;
  /** The slug the bookmark keeps, in the grammar; null for none. */
  readonly slug: string | null;
  /** Whether /go forwards to the bookmark; true only with a slug. */
  readonly forwarding: boolean;
}

/** A folder to get or create for the caller. */
export interface ImportFolderToResolve {
  /** A UUIDv7 generated by the caller (Q91), used when the folder is created. */
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

/** A tag to get or create for the caller. */
export interface ImportTagToResolve {
  /** A UUIDv7 generated by the caller (Q91), used when the tag is created. */
  readonly id: string;
  readonly name: string;
}

/** What the store answers to a request to get or create folders or tags by name. */
export interface ImportResolved {
  /** The identifier of the caller's folder or tag for each name asked, by the name as it was asked. */
  readonly ids: ReadonlyMap<string, string>;
  /** How many of them this call created. */
  readonly created: number;
}

/** The bookmarks of a batch filed in folders and tagged. */
export interface ImportLinks {
  readonly folders: readonly { readonly bookmarkId: string; readonly folderId: string }[];
  readonly tags: readonly { readonly bookmarkId: string; readonly tagId: string }[];
}

/** What the store answers to the request for places under the ceiling. */
export type ImportPlaces =
  /** The workspace cannot be reached: it does not exist, is being deleted, or the account is no member. Nothing is taken. */
  | { readonly kind: "unavailable" }
  /** `taken` places (as many as were wanted, or as many as were left under the ceiling) were taken, and the workspace holds `used` bookmarks that count after it. */
  | { readonly kind: "taken"; readonly taken: number; readonly used: number };

export interface ImportStore extends ImportPreviewStore {
  /** Locks the workspace's row and takes up to `wanted` places under `ceiling` (null: none), raising `bookmark_count` by the number taken. */
  takePlaces(ceiling: number | null, wanted: number): Promise<ImportPlaces>;
  /** Gets the caller's folder of each name (matched without regard to case) or creates it, in the new names' lower-cased order, and answers how many it created. */
  resolveFolders(folders: readonly ImportFolderToResolve[]): Promise<ImportResolved>;
  /** The same for tags. */
  resolveTags(tags: readonly ImportTagToResolve[]): Promise<ImportResolved>;
  /**
   * Inserts the bookmarks, in the order given, and queues the events, in the transaction the store is bound to. A slug that the caller has on a bookmark by then is not written: that bookmark is inserted
   * without a slug and without forwarding, and its identifier is answered in `slugsLost`.
   */
  insertBookmarks(batch: { readonly bookmarks: readonly ImportNewBookmark[]; readonly events: readonly DomainEvent<"bookmark.created">[] }): Promise<{ readonly slugsLost: readonly string[] }>;
  /** Files and tags bookmarks inserted by `insertBookmarks`, leaving the links that exist. */
  linkBookmarks(links: ImportLinks): Promise<void>;
  /**
   * Remembers the account's choices, one for each slug, as the member's own choice is remembered: a choice only for a bookmark that has the slug, forwards, is not plan-archived and that the account can read, replacing the choice the
   * account had for the slug. Answers how many were stored; a choice that fails the checks is not stored and is no failure. The store writes them in as few statements as it can: it is asked once for the whole file.
   */
  rememberChoices(choices: readonly { readonly slug: string; readonly bookmarkId: string }[]): Promise<number>;
}

export interface ImportDependencies {
  readonly store: ImportStore;
  readonly audit: AuditWriter;
  /** A new identifier for a bookmark: strictly ascending across the calls of one import, so the bookmarks list in the order of the file. */
  readonly newBookmarkId: () => string;
  /** A new identifier for an event, a folder or a tag. */
  readonly newId: () => string;
}

export interface ImportAsk {
  readonly file: ImportRequest;
  /** True skips a bookmark that is a duplicate; false imports it. */
  readonly skipDuplicates: boolean;
  /** The workspace's `bookmarks.max`. */
  readonly ceiling: EntitlementLimit;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
}

/** What `importPrepared` is asked: the same as `ImportAsk`, with the file already prepared in place of the file. */
export type ImportPreparedAsk = Omit<ImportAsk, "file"> & { readonly prepared: PreparedImport };

export type ImportOutcome =
  /** The workspace cannot be reached; nothing was written. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "imported"; readonly result: ImportResult }
  /** The file would create `newNames` new folders and tags together, more than one import may. Nothing was written, except that the places may have been taken: the caller's transaction must not commit. */
  | { readonly kind: "too_many_names"; readonly newNames: number }
  /** The file names `names` distinct folder and tag spellings together, more than `IMPORT_MAX_DISTINCT_NAMES`, whether or not the caller has them and whether or not a bookmark that names them is created. Nothing was written: the store was not asked anything. */
  | { readonly kind: "too_many_distinct_names"; readonly names: number }
  /** The bookmarks the import would create would make `links` folder and tag links together, more than one import may. Nothing was written, except that the places may have been taken: the caller's transaction must not commit. */
  | { readonly kind: "too_many_links"; readonly links: number };

type Placed = { readonly kind: "refused"; readonly refusal: ImportRefusal } | { readonly kind: "duplicate"; readonly bookmark: ImportBookmark } | { readonly kind: "candidate"; readonly bookmark: ImportBookmark };

const NOTHING_RESOLVED: ImportResolved = { ids: new Map(), created: 0 };

function missing(kind: string): never {
  throw new Error(`the store did not resolve a ${kind} the import needs`);
}

/** The identifier the store resolved for a spelling of a name: that of the wanted name it stands for. */
function idOf(spelledAs: ReadonlyMap<string, string>, ids: ReadonlyMap<string, string>, name: string, kind: string): string {
  return ids.get(spelledAs.get(name) ?? missing(kind)) ?? missing(kind);
}

/** A bookmark the import wrote with a slug it kept and forwarding on, by its place in the file. */
type Forwarding = ReadonlyMap<number, { readonly id: string; readonly slug: string }>;

/** The choices of the file to restore, one for each slug, in the order of the file: those whose ref names exactly one bookmark of the file, which is in `forwarding` with the slug the choice names. */
function choicesToRestore(choices: PreparedChoices, forwarding: Forwarding): { slug: string; bookmarkId: string }[] {
  if (choices.preferences.length === 0 || forwarding.size === 0) {
    return [];
  }
  const placeOfRef = new Map(choices.refs.map(({ ref, place }) => [ref, place]));
  const chosen = new Map<string, string>();
  for (const preference of choices.preferences) {
    const slug = parseSlug(preference.slug);
    const place = placeOfRef.get(preference.bookmarkRef);
    const bookmark = place === undefined || place === null ? undefined : forwarding.get(place);
    if (slug !== undefined && bookmark?.slug === slug) {
      chosen.delete(slug);
      chosen.set(slug, bookmark.id);
    }
  }
  return [...chosen].map(([slug, bookmarkId]) => ({ slug, bookmarkId }));
}

/** Imports the file in the transaction the dependencies are bound to; nothing is written when the workspace cannot be reached. */
export async function importBookmarks(dependencies: ImportDependencies, ask: ImportAsk): Promise<ImportOutcome> {
  const { file, ...rest } = ask;
  return importPrepared(dependencies, { ...rest, prepared: await prepareImportInSlices(file) });
}

/** `importBookmarks` for a file that has been prepared already (`prepareImport`), here or on another thread: the work of reading the file is done, and what is left is the questions to the store and the writes. */
export async function importPrepared({ store, audit, newBookmarkId, newId }: ImportDependencies, { prepared, ...ask }: ImportPreparedAsk): Promise<ImportOutcome> {
  if (prepared.kind === "too_many_distinct_names") {
    return { kind: "too_many_distinct_names", names: prepared.names };
  }
  const { reads, names: fileNames, choices: fileChoices } = prepared;
  const canonicals = canonicalsOf(reads);
  const existing = ask.skipDuplicates && canonicals.length > 0 ? await store.existingCanonicalUrls(canonicals) : new Set<string>();

  const seen = new Set<string>();
  const placed: Placed[] = reads.map((read) => {
    if (isRefusal(read)) {
      return { kind: "refused", refusal: read };
    }
    const duplicate = ask.skipDuplicates && (existing.has(read.canonical) || seen.has(read.canonical));
    seen.add(read.canonical);
    return duplicate ? { kind: "duplicate", bookmark: read } : { kind: "candidate", bookmark: read };
  });
  const candidates = placed.flatMap((item) => (item.kind === "candidate" ? [item.bookmark] : []));
  const wanted = candidates.length;

  const used = await store.bookmarkCount();
  if (used === undefined) {
    return { kind: "unavailable" };
  }
  const assumed = candidates.slice(0, roomUnder(ask.ceiling, used));
  let names = await planPreparedNames(store, fileNames, assumed);
  const assumedOver = overNewNames(await missingNames(store, names));
  if (assumedOver !== undefined) {
    return { kind: "too_many_names", newNames: assumedOver };
  }
  const assumedLinks = overLinks(assumed, names);
  if (assumedLinks !== undefined) {
    return { kind: "too_many_links", links: assumedLinks };
  }

  const places = await store.takePlaces(ask.ceiling === "unlimited" ? null : ask.ceiling, wanted);
  if (places.kind === "unavailable") {
    return { kind: "unavailable" };
  }
  if (places.taken > wanted) {
    throw new Error("the store took more places than the import wanted");
  }

  const skipped: ImportResult["skipped"] = [];
  const failed: ImportResult["failed"] = [];
  const created: ImportBookmark[] = [];
  for (const item of placed) {
    if (item.kind === "refused") {
      failed.push({ ...entry(item.refusal), reason: item.refusal.reason });
    } else if (item.kind === "duplicate") {
      skipped.push({ ...entry(item.bookmark), reason: "duplicate" });
    } else if (created.length < places.taken) {
      created.push(item.bookmark);
    } else {
      skipped.push({ ...entry(item.bookmark), reason: "bookmark_limit_reached" });
    }
  }

  if (created.length !== assumed.length) {
    names = await planPreparedNames(store, fileNames, created);
    const over = overNewNames(await missingNames(store, names));
    if (over !== undefined) {
      return { kind: "too_many_names", newNames: over };
    }
    const links = overLinks(created, names);
    if (links !== undefined) {
      return { kind: "too_many_links", links };
    }
  }

  const slugs = slugsToCheck(created);
  const slugPlan = planSlugs(created, slugs.length > 0 ? await store.existingSlugs(slugs) : new Set<string>());
  const folders = names.folders.length > 0 ? await store.resolveFolders(names.folders.map((folder) => ({ id: newId(), ...folder }))) : NOTHING_RESOLVED;
  const tags = names.tags.length > 0 ? await store.resolveTags(names.tags.map((name) => ({ id: newId(), name }))) : NOTHING_RESOLVED;

  const lost: ImportResult["droppedSlugs"] = [];
  const forwarding = new Map<number, { id: string; slug: string }>();
  for (let from = 0; from < created.length; from += IMPORT_BATCH_SIZE) {
    const batch = created.slice(from, from + IMPORT_BATCH_SIZE).map((bookmark) => {
      const slug = slugPlan.kept.get(bookmark.position) ?? null;
      const row: ImportNewBookmark = {
        id: newBookmarkId(),
        ownerId: ask.accountId,
        url: bookmark.url,
        urlCanonical: bookmark.canonical,
        host: bookmark.host,
        title: bookmark.title,
        description: bookmark.description,
        pinned: bookmark.pinned,
        slug,
        forwarding: slug !== null && bookmark.forwarding,
      };
      return { bookmark, row };
    });
    const { slugsLost } = await store.insertBookmarks({
      bookmarks: batch.map(({ row }) => row),
      events: batch.map(({ row }) => ({ eventId: newId(), name: "bookmark.created", payload: { workspaceId: ask.workspaceId, bookmarkId: row.id, accountId: ask.accountId } })),
    });
    const lostIds = new Set(slugsLost.map((id) => id.toLowerCase()));
    for (const { bookmark, row } of batch) {
      if (lostIds.delete(row.id.toLowerCase())) {
        lost.push({ ...entry(bookmark), slug: row.slug ?? "", reason: "slug_conflict" });
      } else if (row.slug !== null && row.forwarding) {
        forwarding.set(bookmark.position, { id: row.id, slug: row.slug });
      }
    }
    if (lostIds.size > 0) {
      throw new Error("the store reported a lost slug for a bookmark outside the batch");
    }
    const links: ImportLinks = {
      folders: batch.flatMap(({ bookmark, row }) => [...new Set(bookmark.folders.map((name) => idOf(names.folderOf, folders.ids, name, "folder")))].map((folderId) => ({ bookmarkId: row.id, folderId }))),
      tags: batch.flatMap(({ bookmark, row }) => [...new Set(bookmark.tags.map((name) => idOf(names.tagOf, tags.ids, name, "tag")))].map((tagId) => ({ bookmarkId: row.id, tagId }))),
    };
    if (links.folders.length > 0 || links.tags.length > 0) {
      await store.linkBookmarks(links);
    }
  }

  const choices = choicesToRestore(fileChoices, forwarding);
  if (choices.length > 0) {
    await store.rememberChoices(choices);
  }

  const droppedSlugs = [...slugPlan.dropped, ...lost].sort((a, b) => a.position - b.position);
  const result: ImportResult = {
    detected: { bookmarks: reads.length, ...names.detected },
    created: created.length,
    skipped,
    failed,
    slugsDropped: droppedSlugs.length,
    droppedSlugs,
    foldersCreated: folders.created,
    tagsCreated: tags.created,
  };
  await audit.write({
    action: "import.completed",
    workspaceId: ask.workspaceId.toLowerCase(),
    actor: ask.actor,
    metadata: {
      created: String(result.created),
      skipped: String(result.skipped.length),
      failed: String(result.failed.length),
      slugsDropped: String(result.slugsDropped),
      foldersCreated: String(result.foldersCreated),
      tagsCreated: String(result.tagsCreated),
    },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "imported", result };
}
