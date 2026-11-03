import { IMPORT_MAX_BOOKMARKS, type ImportFileBookmark } from "@slugbase/contracts";
import { decodeCharacterReferences, isRawTextElement, nextMarkup, rawTextEnd } from "../bookmarks/metadata.ts";

// The reader of a browser's bookmark file (doc 02 section 13.1, doc 04 section 10.9, doc 10 T13): Netscape bookmark HTML as Chrome, Edge, Firefox and Safari write it, turned into the bookmarks of
// the JSON import, which then judges them exactly as it judges a file of its own. The file is untrusted text. It is read in one pass with the tag scanner of the page-metadata parser (`nextMarkup`): no
// document tree is built, nothing is evaluated or followed, and every search either moves the cursor past what it found or ends the walk, so the work is linear in the length of the file. A script,
// style or title element is skipped as text, a comment is skipped, and a tag the file ends in is the end of the file. Nothing recurses: the folders a link sits in are a stack of names that holds at
// most `MAX_FOLDER_DEPTH` of them, so a file of a million nested lists costs a counter and not memory.
//
// A link is an `<A HREF>`; one with no HREF (an anchor) is no bookmark. Its title is the text up to the next tag that ends it (`</A>` or the start of another entry), with other markup in it left out; character
// references are decoded once and whitespace is made one space. A link is filed in the folder whose `<H3>` names the list it sits in, by that name alone (browser folders are flat in SlugBase, Q33), and a
// list that no `<H3>` names, such as the first one of a file, belongs to the folder around it, or to none. `TAGS` is split at commas. The description (`<DD>`), `ADD_DATE`, `SHORTCUTURL` and the other
// attributes are not read. What a link's address or text is worth is for the import to say: the address goes through the bookmark URL module, so a bookmarklet or a `place:` query is a failure there.
// More than `IMPORT_MAX_BOOKMARKS` links end the read, and the file is refused whole.

/** The most folders deep the walk keeps names for; a list nested deeper is counted and belongs to the folder at this depth. */
const MAX_FOLDER_DEPTH = 128;

/** The most characters of the text of one title or folder name the walk keeps; the import cuts it to the stored limit. */
const TEXT_MAX_LENGTH = 4096;

/** The most tags of one link the walk keeps. */
const MAX_TAGS_PER_BOOKMARK = 1000;

const KEPT_ATTRIBUTES: ReadonlySet<string> = new Set(["a", "h3"]);

// The tags that begin or end an entry: the text of a link or a folder name stops at any of them, so a link whose `</A>` is missing does not take the entries after it.
const ENTRY_TAGS: ReadonlySet<string> = new Set(["a", "dt", "dd", "dl", "h1", "h2", "h3", "hr", "p"]);

const WHITESPACE_RUN = /\s+/g;

export type NetscapeFile =
  | { readonly kind: "parsed"; readonly bookmarks: readonly ImportFileBookmark[] }
  /** The file has more than `IMPORT_MAX_BOOKMARKS` links. */
  | { readonly kind: "too_many" };

/** What the walk is collecting the text of. */
type Collecting =
  | { readonly kind: "link"; readonly href: string; readonly folder: string | null; readonly tags: readonly string[]; text: string }
  | { readonly kind: "folder"; text: string };

function plain(text: string): string {
  return decodeCharacterReferences(text).replace(WHITESPACE_RUN, " ").trim();
}

function tagsOf(attribute: string | undefined): string[] {
  if (attribute === undefined) {
    return [];
  }
  return decodeCharacterReferences(attribute)
    .split(",", MAX_TAGS_PER_BOOKMARK)
    .map((tag) => tag.replace(WHITESPACE_RUN, " ").trim())
    .filter((tag) => tag !== "");
}

/** The bookmarks of a browser's bookmark file, in the order of the file. The bytes are read as UTF-8; a sequence that is not is replaced, never an error. */
export function parseNetscapeBookmarks(file: Uint8Array): NetscapeFile {
  const text = new TextDecoder("utf-8").decode(file).replaceAll("\u0000", "");
  const bookmarks: ImportFileBookmark[] = [];
  const folders: (string | null)[] = [];
  let overflow = 0;
  let links = 0;
  // What the walk has read and not yet used: the name of the last `<H3>`, which the next list takes, and the entry whose text is being read. They are one object because `finish` changes them.
  const pending: { named: string | null; collecting: Collecting | undefined } = { named: null, collecting: undefined };

  const folderHere = (): string | null => folders[folders.length - 1] ?? null;

  const finish = (): void => {
    const { collecting } = pending;
    if (collecting?.kind === "link") {
      bookmarks.push({ url: collecting.href, title: plain(collecting.text), folders: collecting.folder === null ? [] : [collecting.folder], tags: [...collecting.tags] });
    } else if (collecting?.kind === "folder") {
      const name = plain(collecting.text);
      pending.named = name === "" ? null : name;
    }
    pending.collecting = undefined;
  };

  let cursor = 0;
  for (;;) {
    const token = nextMarkup(text, cursor, KEPT_ATTRIBUTES);
    if (pending.collecting !== undefined && pending.collecting.text.length < TEXT_MAX_LENGTH && token.start > cursor) {
      pending.collecting.text += text.slice(cursor, Math.min(token.start, cursor + TEXT_MAX_LENGTH));
    }
    if (token.kind === "eof") {
      break;
    }
    cursor = token.end;
    if (token.kind === "other") {
      continue;
    }

    if (token.kind === "end") {
      if ((token.name === "a" && pending.collecting?.kind === "link") || (token.name === "h3" && pending.collecting?.kind === "folder")) {
        finish();
      } else if (token.name === "dl") {
        finish();
        pending.named = null;
        if (overflow > 0) {
          overflow -= 1;
        } else {
          folders.pop();
        }
      }
      continue;
    }

    const { tag } = token;
    if (isRawTextElement(tag.name) || tag.name === "title") {
      const closing = rawTextEnd(text, tag.name, cursor);
      if (closing === -1) {
        break;
      }
      cursor = closing;
      continue;
    }
    if (!ENTRY_TAGS.has(tag.name)) {
      continue;
    }
    finish();
    if (tag.name === "h3") {
      pending.collecting = { kind: "folder", text: "" };
    } else if (tag.name === "dl") {
      const name = pending.named ?? folderHere();
      pending.named = null;
      if (folders.length < MAX_FOLDER_DEPTH) {
        folders.push(name);
      } else {
        overflow += 1;
      }
    } else if (tag.name === "a") {
      const href = tag.attributes.get("href");
      if (href !== undefined) {
        links += 1;
        if (links > IMPORT_MAX_BOOKMARKS) {
          return { kind: "too_many" };
        }
        pending.collecting = { kind: "link", href: decodeCharacterReferences(href), folder: folderHere(), tags: tagsOf(tag.attributes.get("tags")), text: "" };
      }
    }
  }
  finish();
  return { kind: "parsed", bookmarks };
}
