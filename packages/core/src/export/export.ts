import { EXPORT_FORMAT, EXPORT_VERSION } from "@slugbase/contracts";
import type { AuditActor, AuditWriter } from "../audit/writer.ts";

// The SlugBase JSON export of a member (doc 02 sections 13.2 and 13.3, doc 05 section 2.4, doc 10 T1 and T2): the member's own bookmarks, folders and tags in the active workspace as
// one versioned document, generated on demand, streamed and stored nowhere. Every read names the member as the owner, so another member's content and content with no owner is never in
// the document. The export is recorded before the first byte, in the transaction that counts it, as one `export.created` audit event with counts only; the document is then read page by page,
// each page in a transaction of its own that ends before the page is handed to the client, so a slow reader holds no transaction and the server holds no more than a page. A failure after the
// first byte errors the stream, which ends the connection with the document unfinished: what was received does not parse as JSON, so a truncated file never reads as a complete one.
//
// The document is deterministic, which the round trip of the import relies on: bookmarks in the order of their identifiers (UUIDv7, so the order of their creation), folders and tags by the bytes
// of their names, the folders and tags of a bookmark by the bytes of their names, and the `ref` of a bookmark by its position, never a database identifier. A page is a keyset slice, not a
// snapshot: a change made while the export runs is in the document or not, page by page, but no row is read twice.

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

export interface ExportFolderRow {
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

/** What the member has to export, and the workspace it is in. */
export interface ExportSummary {
  readonly workspaceName: string;
  /** The member's bookmarks, plan-archived ones included. */
  readonly bookmarks: number;
  readonly folders: number;
  readonly tags: number;
}

export interface ExportStore {
  /** The name of the workspace of the transaction and the counts of what `ownerId` owns in it; undefined when the workspace cannot be read. */
  summary(ownerId: string): Promise<ExportSummary | undefined>;
  /** At most `limit` of the folders `ownerId` owns whose name sorts after `after` (the first page when undefined), by the bytes of the name. */
  folders(ownerId: string, after: string | undefined, limit: number): Promise<readonly ExportFolderRow[]>;
  /** At most `limit` names of the tags `ownerId` owns that sort after `after` (the first page when undefined), by the bytes of the name. */
  tags(ownerId: string, after: string | undefined, limit: number): Promise<readonly string[]>;
  /** At most `limit` of the bookmarks `ownerId` owns, plan-archived ones included, whose identifier is greater than `after` (the first page when undefined), in the order of the identifier. */
  bookmarks(ownerId: string, after: string | undefined, limit: number): Promise<readonly ExportBookmarkRow[]>;
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
}

export type ExportStartOutcome =
  | { readonly kind: "started"; readonly summary: ExportSummary }
  /** The workspace of the request cannot be read (it is being deleted); nothing is recorded. */
  | { readonly kind: "unavailable" };

/** Counts what the member owns and records the export as `export.created`, in the transaction the dependencies are bound to; nothing is written when the workspace cannot be read. */
export async function startExport({ store, audit }: ExportStartDependencies, ask: ExportStartAsk): Promise<ExportStartOutcome> {
  const summary = await store.summary(ask.accountId.toLowerCase());
  if (summary === undefined) {
    return { kind: "unavailable" };
  }
  await audit.write({
    action: "export.created",
    workspaceId: ask.workspaceId.toLowerCase(),
    actor: ask.actor,
    metadata: { bookmarks: String(summary.bookmarks), folders: String(summary.folders), tags: String(summary.tags), shared: "0" },
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
    const rows = await page((store) => store.folders(owner, after, pageSize));
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
    const names = await page((store) => store.tags(owner, after, pageSize));
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
  let bookmarkAfter: string | undefined;
  for (;;) {
    const after = bookmarkAfter;
    const rows = await page((store) => store.bookmarks(owner, after, pageSize));
    if (rows.length > 0) {
      yield (
        separator +
        rows
          .map((row) => {
            position += 1;
            return JSON.stringify({
              ref: `b${String(position)}`,
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

  yield '],"goPreferences":[],"shared":[]}';
}

/**
 * The pieces of a document as a stream of bytes. A piece is read only when the client asks for more, so at most one page is held, whatever the size of the export. The stream errors, and the
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
