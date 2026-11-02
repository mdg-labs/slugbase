import { EXPORT_PAGE_SIZE, pieceStream, type ExportSharedRow, type ExportStreamAsk } from "./export.ts";

// The lossy export for browsers (doc 02 section 13.2, doc 04 sections 7 and 10.9, doc 10 T13 and T14, Q29 and Q33): the member's own bookmarks as a Netscape bookmark file, which Chrome, Edge, Firefox and
// Safari import and `parseNetscapeBookmarks` reads back. It is one flat level of sections, an `<H3>` for each folder the member owns, used or not, and under it the bookmarks filed in it, so a bookmark in
// several folders is under each of them; a bookmark in none is at the top level, before the first folder. The sections are in the order of the folder identifier, that is by the millisecond a folder was made and arbitrary among folders made in the same millisecond, as an import makes them. A link carries the address, the slug as `SHORTCUTURL` and the tags, comma-separated, as `TAGS`.
// A plan-archived bookmark is in it, since the format has no flag for one; the description, the pin and the forwarding flag are not, since it has no place for them.
//
// Every title, address, folder name, tag and slug is HTML-escaped (`escapeHtml`), in text and in attribute values, and nothing else of the member's is written, so a browser that opens the file, or an
// import that reads it, finds no markup of the member's making. The export is counted and recorded as `export.created` before the first byte, as the JSON export is, and the file is then read page by page,
// each page in a transaction of its own that is over before the page is handed to the client; nothing is stored. The sections are read by folder (`folderBookmarks`), since the pages of the JSON export
// are by bookmark identifier and cannot give a section, and the folders and their sections are paged by the identifier of the folder, which a rename does not change: the name is only the heading, read with
// the page of folders, so a folder renamed during a download keeps its place and its bookmarks. The identifier stays in the store and is never written to the file. There is no snapshot: a folder
// deleted, a bookmark moved to another folder or deleted during a download follows the rows as each page reads them, so the file shows the library page by page and not at one instant, and a bookmark
// moved between folders may be in both sections or in neither. Only a failed read ends the file before its closing list. A tag whose name holds a comma is written as it is, and the format splits it at
// the comma, which the file cannot express otherwise.
//
// With `includeShared` the bookmarks other members shared with the member that they can read (a direct share, a team's or a shared folder's) follow the unfiled ones at the top level, before the first
// section, as links with the address, the title and the slug and no tags, written field by field from what the store answers: the owner's tags, folders and pin are no part of what the member
// can read. They are read page by page like the rest, so a share that ends during a download drops the bookmark from the pages not yet read.

/** The name of the attachment: the UTC day of the export, and nothing of the workspace. */
export function exportNetscapeFilename(exportedAt: Date): string {
  return `slugbase-export-${exportedAt.toISOString().slice(0, 10)}.html`;
}

/** A bookmark as the store reads it for the Netscape file. The identifier only positions the next page; it is not written. */
export interface NetscapeBookmarkRow {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly slug: string | null;
  /** The names of the member's tags the bookmark carries, sorted by the bytes of the name. */
  readonly tags: readonly string[];
}

/** A folder as the store reads it for the Netscape file: the identifier positions the next page and names the section, and only the name is written. */
export interface NetscapeSectionRow {
  readonly id: string;
  readonly name: string;
}

/** The reads of the Netscape export, bound to one transaction. */
export interface NetscapeExportStore {
  /** At most `limit` of the folders `ownerId` owns, used or not, whose identifier is greater than `after` (the first page when undefined), in the order of the identifier. */
  sections(ownerId: string, after: string | undefined, limit: number): Promise<readonly NetscapeSectionRow[]>;
  /** At most `limit` of the bookmarks `ownerId` owns that are filed in its folder `folderId`, plan-archived ones included, whose identifier is greater than `after`, in the order of the identifier. Nothing when the folder is not the owner's or no longer exists. */
  folderBookmarks(ownerId: string, folderId: string, after: string | undefined, limit: number): Promise<readonly NetscapeBookmarkRow[]>;
  /** At most `limit` of the bookmarks `ownerId` owns that are filed in none of its folders, plan-archived ones included, whose identifier is greater than `after`, in the order of the identifier. */
  unfiledBookmarks(ownerId: string, after: string | undefined, limit: number): Promise<readonly NetscapeBookmarkRow[]>;
  /** At most `limit` of the bookmarks of other members that `accountId` can read through a share, plan-archived ones never, whose identifier is greater than `after`, in the order of the identifier. */
  shared(accountId: string, after: string | undefined, limit: number): Promise<readonly ExportSharedRow[]>;
}

export interface NetscapeStreamDependencies {
  /** Runs `read` in a transaction of its own that is over before the promise settles. */
  readonly page: <T>(read: (store: NetscapeExportStore) => Promise<T>) => Promise<T>;
  /** Told of the failure that ended the stream, once, with whatever the transaction raised. */
  readonly onFailure: (error: unknown) => void;
  /** The page size; `EXPORT_PAGE_SIZE` when left out. */
  readonly pageSize?: number;
}

const HTML_SPECIALS = /[&<>"']/g;

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for an element or a quoted attribute value: the five characters that HTML gives a meaning are references, so nothing a member typed is markup. */
export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIALS, (character) => ESCAPES[character] ?? character);
}

const HEAD = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

function link(row: Pick<NetscapeBookmarkRow, "url" | "title" | "slug" | "tags">, indent: string): string {
  const slug = row.slug === null ? "" : ` SHORTCUTURL="${escapeHtml(row.slug)}"`;
  const tags = row.tags.length === 0 ? "" : ` TAGS="${escapeHtml(row.tags.join(","))}"`;
  return `${indent}<DT><A HREF="${escapeHtml(row.url)}"${slug}${tags}>${escapeHtml(row.title)}</A>\n`;
}

/** The pieces of the file in order, as text; a piece is at most a page. */
async function* pieces({ page, pageSize = EXPORT_PAGE_SIZE }: NetscapeStreamDependencies, ask: Pick<ExportStreamAsk, "accountId" | "includeShared">): AsyncGenerator<string, void, undefined> {
  const owner = ask.accountId.toLowerCase();
  yield HEAD;

  let unfiledAfter: string | undefined;
  for (;;) {
    const after = unfiledAfter;
    const rows = await page((store) => store.unfiledBookmarks(owner, after, pageSize));
    if (rows.length > 0) {
      yield rows.map((row) => link(row, "    ")).join("");
      unfiledAfter = rows[rows.length - 1]?.id;
    }
    if (rows.length < pageSize) {
      break;
    }
  }

  if (ask.includeShared) {
    let sharedAfter: string | undefined;
    for (;;) {
      const after = sharedAfter;
      const rows = await page((store) => store.shared(owner, after, pageSize));
      if (rows.length > 0) {
        yield rows.map((row) => link({ url: row.url, title: row.title, slug: row.slug, tags: [] }, "    ")).join("");
        sharedAfter = rows[rows.length - 1]?.id;
      }
      if (rows.length < pageSize) {
        break;
      }
    }
  }

  let folderAfter: string | undefined;
  for (;;) {
    const after = folderAfter;
    const folders = await page((store) => store.sections(owner, after, pageSize));
    for (const folder of folders) {
      yield `    <DT><H3>${escapeHtml(folder.name)}</H3>\n    <DL><p>\n`;
      let bookmarkAfter: string | undefined;
      for (;;) {
        const resume = bookmarkAfter;
        const rows = await page((store) => store.folderBookmarks(owner, folder.id, resume, pageSize));
        if (rows.length > 0) {
          yield rows.map((row) => link(row, "        ")).join("");
          bookmarkAfter = rows[rows.length - 1]?.id;
        }
        if (rows.length < pageSize) {
          break;
        }
      }
      yield "    </DL><p>\n";
    }
    if (folders.length < pageSize) {
      break;
    }
    folderAfter = folders[folders.length - 1]?.id;
  }

  yield "</DL><p>\n";
}

/**
 * The Netscape bookmark file as a stream of bytes. A page is read only when the client asks for more, so at most one page is held, whatever the size of the export. The stream errors, and the connection
 * with it, when a page cannot be read; `onFailure` is told first, so a file that ends before its closing `</DL>` is one that failed.
 */
export function exportNetscapeStream(dependencies: NetscapeStreamDependencies, ask: Pick<ExportStreamAsk, "accountId" | "includeShared">): ReadableStream<Uint8Array> {
  return pieceStream(pieces(dependencies, ask), dependencies.onFailure);
}
