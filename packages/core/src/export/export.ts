import { EXPORT_FORMAT, EXPORT_VERSION } from "@slugbase/contracts";
import type { AuditActor, AuditWriter } from "../audit/writer.ts";

// The SlugBase JSON export of a member (doc 02 sections 13.2 and 13.3, doc 05 section 2.4, doc 10 T1 and T2): the member's own bookmarks, folders and tags in the active workspace as
// one versioned document, generated on demand, streamed and stored nowhere. Every read names the member as the owner, so another member's content and content with no owner is never in
// the document. The export is recorded before the first byte, in the transaction that counts it, as one `export.created` audit event with counts only; the document is then read page by page,
// each page in a transaction of its own that ends before the page is handed to the client, so a slow reader holds no transaction and the server holds no more than a page, besides the ref of each bookmark that has a slug and forwards (below), which is kept for the length of the download. A failure after the
// first byte errors the stream, which ends the connection with the document unfinished: what was received does not parse as JSON, so a truncated file never reads as a complete one.
//
// The document is deterministic, which the round trip of the import relies on: bookmarks in the order of their identifiers (UUIDv7, so the order of their creation), folders and tags by the bytes
// of their names, the folders and tags of a bookmark by the bytes of their names, and the `ref` of a bookmark by its position, never a database identifier. A page is a keyset slice, not a
// snapshot: a change made while the export runs is in the document or not, page by page, but no row is read twice.
//
// The document's `goPreferences` (doc 02 section 6.4) are the member's remembered slug choices whose bookmark is the member's own, is still a candidate of the slug (it has the slug and forwards) and is in the document,
// each written as the slug and the `ref` of that bookmark, in the order of the slugs. A choice names a bookmark by its database identifier, which is never written, so the service keeps the ref it gave each bookmark that has a
// slug and forwards (one entry for each such bookmark, the only memory it holds beyond a page) and writes a choice only when its bookmark is one of them: a bookmark made after its page was read, or one that stopped
// forwarding, has no ref, so its choice is left out and never points at another bookmark. Another member's bookmark is not among them, and the store reads only choices whose bookmark the member owns. With no bookmark that forwards the store is not asked.
//
// With `includeShared` the document's `shared` list holds the bookmarks other members shared with the member (doc 02 sections 8.2 and 13.2): `url`, `title`, `description`, `slug`, the name of the
// owner (null when the bookmark has no owner) and the flag `shared: true`, written field by field from what the store answers, so a row that carried more (a tag, a folder, the pin, a recipient) would still
// not reach the file. The store answers only what the member can read at the moment of each page, so a share that ends during the export drops the bookmark from the pages not yet read; a bookmark
// a downgrade archived is never read. Without it nothing shared is asked of the store and the list is empty.
//
// A selection (`only`, doc 02 section 5.8) restricts the document to the bookmarks named by identifier, which the route resolved before the first byte from the identifiers of the request or from the filters of the list. Every read then takes the
// identifiers as one more condition besides the owner and the workspace it already names, so an identifier of a bookmark the member can neither own nor read matches nothing and the document, its counts and the audit event cannot tell it from one that never
// existed. The member's own bookmarks of the selection are in `bookmarks` in full, the ones shared with the member in `shared` as their readable fields (a selection is the ask for them, so `includeShared` is not needed), `folders` and `tags` hold only the
// ones those own bookmarks use, and `goPreferences` the choices for them.

/** The most rows one page of the export holds. */
export const EXPORT_PAGE_SIZE = 500;

/** A bookmark as the store reads it. The identifier only positions the next page; it is not written to the document. */
export interface ExportBookmarkRow {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly pinned: boolean;
  readonly planArchived: boolean;
  /** The names of the member's folders the bookmark is filed in, sorted by the bytes of the name. */
  readonly folders: readonly string[];
  /** The names of the member's tags the bookmark carries, sorted by the bytes of the name. */
  readonly tags: readonly string[];
}

/** A remembered slug choice as the store reads it. The identifier of the bookmark only finds its ref; it is not written to the document. */
export interface ExportGoPreferenceRow {
  readonly slug: string;
  readonly bookmarkId: string;
}

export interface ExportFolderRow {
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

/** A bookmark shared with the member as the store reads it: the readable fields and nothing of the owner's own. The identifier only positions the next page; it is not written to the document. */
export interface ExportSharedRow {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly slug: string | null;
  /** The display name of the owner; null when the bookmark has no owner or its owner's name cannot be read. */
  readonly ownerName: string | null;
}

/** What the member has to export, and the workspace it is in. */
export interface ExportSummary {
  readonly workspaceName: string;
  /** The member's bookmarks, plan-archived ones included. */
  readonly bookmarks: number;
  readonly folders: number;
  readonly tags: number;
  /** The bookmarks shared with the member that they can read, plan-archived ones left out; 0 when the summary was not asked for them. */
  readonly shared: number;
}

export interface ExportStore {
  /**
   * The name of the workspace of the transaction and the counts of what `ownerId` owns in it, and with `includeShared` of the bookmarks shared with `ownerId` that it can read; undefined when the workspace cannot be read. With `only`, the counts are of
   * the bookmarks among those identifiers that `ownerId` owns (or can read through a share, with `includeShared`) and of the folders and tags those own bookmarks use; the same holds for every read below that takes `only`.
   */
  summary(ownerId: string, includeShared: boolean, only?: readonly string[]): Promise<ExportSummary | undefined>;
  /** At most `limit` of the folders `ownerId` owns whose name sorts after `after` (the first page when undefined), by the bytes of the name. */
  folders(ownerId: string, after: string | undefined, limit: number, only?: readonly string[]): Promise<readonly ExportFolderRow[]>;
  /** At most `limit` names of the tags `ownerId` owns that sort after `after` (the first page when undefined), by the bytes of the name. */
  tags(ownerId: string, after: string | undefined, limit: number, only?: readonly string[]): Promise<readonly string[]>;
  /** At most `limit` of the bookmarks `ownerId` owns, plan-archived ones included, whose identifier is greater than `after` (the first page when undefined), in the order of the identifier. */
  bookmarks(ownerId: string, after: string | undefined, limit: number, only?: readonly string[]): Promise<readonly ExportBookmarkRow[]>;
  /** At most `limit` of the remembered slug choices of `ownerId` whose bookmark `ownerId` owns and that has the slug and forwards, plan-archived ones included, whose slug sorts after `after` (the first page when undefined), by the bytes of the slug. */
  goPreferences(ownerId: string, after: string | undefined, limit: number, only?: readonly string[]): Promise<readonly ExportGoPreferenceRow[]>;
  /** At most `limit` of the bookmarks of other members that `accountId` can read through a share (directly, through a team or through a shared folder), plan-archived ones never, whose identifier is greater than `after` (the first page when undefined), in the order of the identifier. */
  shared(accountId: string, after: string | undefined, limit: number, only?: readonly string[]): Promise<readonly ExportSharedRow[]>;
}

export interface ExportStartDependencies {
  /** The store and the writer of the one transaction that counts the export and records it. */
  readonly store: ExportStore;
  readonly audit: AuditWriter;
}

export interface ExportStartAsk {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  /** Whether the export holds the bookmarks shared with the member, which the event then counts. */
  readonly includeShared: boolean;
  /** The identifiers of a selection; the whole export when undefined. See `readsShared`. */
  readonly only?: readonly string[] | undefined;
}

export type ExportStartOutcome =
  | { readonly kind: "started"; readonly summary: ExportSummary }
  /** The workspace of the request cannot be read (it is being deleted); nothing is recorded. */
  | { readonly kind: "unavailable" };

/** Whether the bookmarks shared with the member are read: when the request asked for them, and always for a selection, which is the ask for the ones it names or matches. */
export function readsShared(ask: { readonly includeShared: boolean; readonly only?: readonly string[] | undefined }): boolean {
  return ask.includeShared || ask.only !== undefined;
}

/** Counts what the member owns and records the export as `export.created`, in the transaction the dependencies are bound to; nothing is written when the workspace cannot be read. */
export async function startExport({ store, audit }: ExportStartDependencies, ask: ExportStartAsk): Promise<ExportStartOutcome> {
  const summary = await store.summary(ask.accountId.toLowerCase(), readsShared(ask), ask.only);
  if (summary === undefined) {
    return { kind: "unavailable" };
  }
  await audit.write({
    action: "export.created",
    workspaceId: ask.workspaceId.toLowerCase(),
    actor: ask.actor,
    metadata: { bookmarks: String(summary.bookmarks), folders: String(summary.folders), tags: String(summary.tags), shared: String(summary.shared) },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "started", summary };
}

export interface ExportStreamDependencies {
  /** Runs `read` in a transaction of its own that is over before the promise settles. */
  readonly page: <T>(read: (store: ExportStore) => Promise<T>) => Promise<T>;
  /** Told of the failure that ended the stream, once, with whatever the transaction raised. */
  readonly onFailure: (error: unknown) => void;
  /** The page size; `EXPORT_PAGE_SIZE` when left out. */
  readonly pageSize?: number;
}

export interface ExportStreamAsk {
  readonly accountId: string;
  readonly workspaceName: string;
  readonly exportedAt: Date;
  /** Whether the `shared` list is read; it is written empty otherwise. */
  readonly includeShared: boolean;
  /** The identifiers of a selection, as `ExportStartAsk.only`; the whole export when undefined. */
  readonly only?: readonly string[] | undefined;
}

/** The name of the attachment: the UTC day of the export, and nothing of the workspace. */
export function exportFilename(exportedAt: Date): string {
  return `slugbase-export-${exportedAt.toISOString().slice(0, 10)}.json`;
}

/** The pieces of the document in order, as text; a piece is at most a page. */
async function* pieces({ page, pageSize = EXPORT_PAGE_SIZE }: ExportStreamDependencies, ask: ExportStreamAsk): AsyncGenerator<string, void, undefined> {
  const owner = ask.accountId.toLowerCase();
  const head = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: ask.exportedAt.toISOString(),
    workspace: { name: ask.workspaceName },
  };
  yield `${JSON.stringify(head).slice(0, -1)},"folders":[`;

  let separator = "";
  let folderAfter: string | undefined;
  for (;;) {
    const after = folderAfter;
    const rows = await page((store) => store.folders(owner, after, pageSize, ask.only));
    if (rows.length > 0) {
      yield separator + rows.map((row) => JSON.stringify({ name: row.name, icon: row.icon, color: row.color })).join(",");
      separator = ",";
      folderAfter = rows[rows.length - 1]?.name;
    }
    if (rows.length < pageSize) {
      break;
    }
  }

  yield '],"tags":[';
  separator = "";
  let tagAfter: string | undefined;
  for (;;) {
    const after = tagAfter;
    const names = await page((store) => store.tags(owner, after, pageSize, ask.only));
    if (names.length > 0) {
      yield separator + names.map((name) => JSON.stringify(name)).join(",");
      separator = ",";
      tagAfter = names[names.length - 1];
    }
    if (names.length < pageSize) {
      break;
    }
  }

  yield '],"bookmarks":[';
  separator = "";
  let position = 0;
  const refOf = new Map<string, string>();
  let bookmarkAfter: string | undefined;
  for (;;) {
    const after = bookmarkAfter;
    const rows = await page((store) => store.bookmarks(owner, after, pageSize, ask.only));
    if (rows.length > 0) {
      yield (
        separator +
        rows
          .map((row) => {
            position += 1;
            const ref = `b${String(position)}`;
            if (row.slug !== null && row.forwarding) {
              refOf.set(row.id.toLowerCase(), ref);
            }
            return JSON.stringify({
              ref,
              url: row.url,
              title: row.title,
              description: row.description,
              slug: row.slug,
              forwarding: row.forwarding,
              pinned: row.pinned,
              planArchived: row.planArchived,
              folders: row.folders,
              tags: row.tags,
            });
          })
          .join(",")
      );
      separator = ",";
      bookmarkAfter = rows[rows.length - 1]?.id;
    }
    if (rows.length < pageSize) {
      break;
    }
  }

  yield '],"goPreferences":[';
  if (refOf.size > 0) {
    separator = "";
    let preferenceAfter: string | undefined;
    for (;;) {
      const after = preferenceAfter;
      const rows = await page((store) => store.goPreferences(owner, after, pageSize, ask.only));
      const written = rows.flatMap((row) => {
        const bookmarkRef = refOf.get(row.bookmarkId.toLowerCase());
        return bookmarkRef === undefined ? [] : [JSON.stringify({ slug: row.slug, bookmarkRef })];
      });
      if (written.length > 0) {
        yield separator + written.join(",");
        separator = ",";
      }
      if (rows.length < pageSize) {
        break;
      }
      preferenceAfter = rows[rows.length - 1]?.slug;
    }
  }
  yield '],"shared":[';
  if (readsShared(ask)) {
    separator = "";
    let sharedAfter: string | undefined;
    for (;;) {
      const after = sharedAfter;
      const rows = await page((store) => store.shared(owner, after, pageSize, ask.only));
      if (rows.length > 0) {
        yield (
          separator +
          rows.map((row) => JSON.stringify({ url: row.url, title: row.title, description: row.description, slug: row.slug, ownerName: row.ownerName, shared: true })).join(",")
        );
        separator = ",";
        sharedAfter = rows[rows.length - 1]?.id;
      }
      if (rows.length < pageSize) {
        break;
      }
    }
  }
  yield "]}";
}

/**
 * The pieces of a document as a stream of bytes. A piece is read only when the client asks for more, so the stream itself holds at most one page, whatever the size of the export (the JSON generator also keeps the ref map described at the top of this file). The stream errors, and the
 * connection with it, when a piece cannot be read; `onFailure` is told first.
 */
export function pieceStream(source: AsyncGenerator<string, void, undefined>, onFailure: (error: unknown) => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await source.next();
          if (next.done === true) {
            controller.close();
          } else {
            controller.enqueue(encoder.encode(next.value));
          }
        } catch (error) {
          onFailure(error);
          controller.error(error);
        }
      },
      async cancel() {
        await source.return();
      },
    },
    { highWaterMark: 0 },
  );
}

/** The document as a stream of bytes; see `pieceStream`. */
export function exportStream(dependencies: ExportStreamDependencies, ask: ExportStreamAsk): ReadableStream<Uint8Array> {
  return pieceStream(pieces(dependencies, ask), dependencies.onFailure);
}
