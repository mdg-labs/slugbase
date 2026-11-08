// The largest import files the performance suite sends (doc 08 section 5.3, doc 02 section 13.1): a browser bookmark file of close to 5 MiB with 5 000 links, and a SlugBase JSON
// file of 5 000 bookmarks with folders, tags and slugs, some of which the importer has already or an earlier bookmark of the file keeps, so that the import drops them. Both are built from
// the index of the bookmark alone, with no randomness, so every run sends the same bytes. Every address is its own (on a host no seeded bookmark has), so no bookmark is skipped as a
// duplicate, and none is refused: an import of one of these files creates exactly `bookmarks` bookmarks, and an answer that created fewer is not the import the suite means to measure.

/** The most bookmarks one import file holds: `IMPORT_MAX_BOOKMARKS` of `@slugbase/contracts` (tooling/test/perf-budgets.test.ts holds the two together). */
export const IMPORT_FILE_MAX_BOOKMARKS = 5000;

/** The largest import body in bytes: `IMPORT_MAX_BYTES` of `@slugbase/contracts` (held the same way). */
export const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** What the Netscape file leaves under the cap: the multipart envelope is counted apart, and the file part itself may be the cap. */
const NETSCAPE_HEADROOM_BYTES = 1024;

const FOLDERS = 40;
const TAGS = 120;
const JSON_SLUG_CYCLE = 10;
const JSON_REPEAT_CYCLE = 25;
const JSON_INVALID_CYCLE = 50;

export interface ImportFile {
  /** The file as the request sends it: UTF-8 text. */
  readonly body: string;
  /** Its size in bytes. */
  readonly bytes: number;
  /** The bookmarks it holds. */
  readonly bookmarks: number;
}

export interface ImportFileOptions {
  /** The bookmarks of the file; the most there may be by default. */
  readonly bookmarks?: number;
}

export interface JsonImportFileOptions extends ImportFileOptions {
  /** Slugs the importer holds already: every tenth bookmark of the file asks for one of them, and the import drops it. */
  readonly collidingSlugs?: readonly string[];
}

const pad = (index: number): string => String(index).padStart(5, "0");

function checkCount(bookmarks: number): number {
  if (!Number.isInteger(bookmarks) || bookmarks < 1 || bookmarks > IMPORT_FILE_MAX_BOOKMARKS) {
    throw new RangeError(`an import file holds 1 to ${String(IMPORT_FILE_MAX_BOOKMARKS)} bookmarks, not ${String(bookmarks)}`);
  }
  return bookmarks;
}

const tagNames = (index: number): string[] => [`import-tag-${String((index * 7) % TAGS)}`, `import-tag-${String((index * 11 + 3) % TAGS)}`];

/**
 * A browser bookmark file (Netscape bookmark HTML) of `bookmarks` links in forty folders, each tagged, whose addresses are padded so that the file is the size of the largest upload the
 * import takes, less `NETSCAPE_HEADROOM_BYTES`: the same size whatever `bookmarks` is, so a smaller file is longer per link and no longer than the cap.
 */
export function buildNetscapeFile(options: ImportFileOptions = {}): ImportFile {
  const bookmarks = checkCount(options.bookmarks ?? IMPORT_FILE_MAX_BOOKMARKS);
  const target = IMPORT_FILE_MAX_BYTES - NETSCAPE_HEADROOM_BYTES;
  const render = (padding: (index: number) => string): string => {
    const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];
    for (let folder = 0; folder < FOLDERS; folder += 1) {
      lines.push(`<DT><H3>Import folder ${String(folder)}</H3>`, "<DL><p>");
      for (let index = folder; index < bookmarks; index += FOLDERS) {
        lines.push(`<DT><A HREF="https://netscape.import.example.test/p/${pad(index)}/${padding(index)}" ADD_DATE="1700000000" TAGS="${tagNames(index).join(",")}">Imported link ${pad(index)}</A>`);
      }
      lines.push("</DL><p>");
    }
    lines.push("</DL><p>", "");
    return lines.join("\n");
  };
  // The text is ASCII, so its length is its size. The padding of each link is the same number of characters, and the remainder of the division is one more on the first links.
  const base = render(() => "").length;
  const each = Math.floor((target - base) / bookmarks);
  const extra = (target - base) % bookmarks;
  if (each < 0) {
    throw new RangeError("the file is over the size of an import");
  }
  const body = render((index) => "a".repeat(each + (index < extra ? 1 : 0)));
  return { body, bytes: Buffer.byteLength(body), bookmarks };
}

/**
 * A SlugBase JSON file (the export envelope) of `bookmarks` bookmarks in forty folders, tagged, a third of them with a slug and some of those forwarding. A slug is dropped by the import when
 * the importer holds it (every tenth bookmark asks for one of `collidingSlugs`, when given), when an earlier bookmark of the file keeps it (every 25th repeats the slug before it) and when it is
 * outside the grammar (every 50th), so the answer counts dropped slugs of both reasons.
 */
export function buildJsonFile(options: JsonImportFileOptions = {}): ImportFile {
  const bookmarks = checkCount(options.bookmarks ?? IMPORT_FILE_MAX_BOOKMARKS);
  const colliding = options.collidingSlugs ?? [];
  const slugOf = (index: number): string | undefined => {
    if (index % 3 !== 0) {
      return undefined;
    }
    if (index % JSON_INVALID_CYCLE === 0) {
      return `Not A Slug ${pad(index)}`;
    }
    if (index % JSON_REPEAT_CYCLE === 0 && index >= 3) {
      return `json-import-${pad(index - 3)}`;
    }
    if (colliding.length > 0 && index % JSON_SLUG_CYCLE === 0) {
      return colliding[(index / JSON_SLUG_CYCLE) % colliding.length];
    }
    return `json-import-${pad(index)}`;
  };
  const entries = Array.from({ length: bookmarks }, (_, index) => {
    const slug = slugOf(index);
    return {
      ref: `b${String(index + 1)}`,
      url: `https://json.import.example.test/p/${pad(index)}`,
      title: `Imported bookmark ${pad(index)}`,
      description: `Bookmark ${pad(index)} of the SlugBase JSON file of the performance suite.`,
      ...(slug === undefined ? {} : { slug, forwarding: index % 2 === 0 }),
      pinned: index % 97 === 0,
      folders: [`Import folder ${String(index % FOLDERS)}`],
      tags: tagNames(index),
    };
  });
  const document = {
    format: "slugbase-export",
    version: 1,
    folders: Array.from({ length: FOLDERS }, (_, folder) => ({ name: `Import folder ${String(folder)}` })),
    tags: Array.from({ length: TAGS }, (_, tag) => `import-tag-${String(tag)}`),
    bookmarks: entries,
  };
  const body = JSON.stringify(document);
  return { body, bytes: Buffer.byteLength(body), bookmarks };
}

export interface ImportFiles {
  readonly netscape: ImportFile;
  readonly json: ImportFile;
}

/** Both files, at the most the import takes. */
export function buildImportFiles(options: { readonly collidingSlugs?: readonly string[] } = {}): ImportFiles {
  return { netscape: buildNetscapeFile(), json: buildJsonFile(options) };
}
