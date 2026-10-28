// The metadata of a page (doc 02 section 5.4, doc 10 T13): what the `bookmark.fetchMetadata` job reads from the first 512 KiB of an HTML
// response. The parser is tolerant and never executes or follows anything. It walks the text once, with no backtracking pattern over the
// document, so the work is linear in the length of the input and the input is capped before it starts. Every search for a closing marker
// either moves the cursor past what it found or, when nothing closes, ends the walk, so no stretch of text is searched twice. Script, style,
// textarea and comment content is skipped, a tag or raw-text element it cannot finish ends the walk and keeps what it found, an unclosed
// `<title>` ends it too (a browser reads the rest of such a page as the title), and the counts of the tags it reads are capped. Every value it
// returns is plain text: character references decoded once, control characters removed, whitespace collapsed and the length cut to the
// limit of its field. The canonical link is returned as text and is never fetched.

/** The most bytes of an HTML response the job reads and the parser looks at (doc 02 section 5.4). */
export const METADATA_HTML_MAX_BYTES = 512 * 1024;

/** The media types the parser reads; a response of any other type is not parsed. */
export const METADATA_CONTENT_TYPES: readonly string[] = ["text/html", "application/xhtml+xml"];

/** The longest title, in characters; the limit of a bookmark's title. */
export const METADATA_TITLE_MAX_LENGTH = 300;

/** The longest description, in characters; the limit of a bookmark's description. */
export const METADATA_DESCRIPTION_MAX_LENGTH = 1000;

/** The longest site name, in characters. */
export const METADATA_SITE_NAME_MAX_LENGTH = 100;

/** The longest canonical link, in characters; the limit of a bookmark's URL. */
export const METADATA_CANONICAL_URL_MAX_LENGTH = 2048;

/** The longest language tag, in characters. */
export const METADATA_LANGUAGE_MAX_LENGTH = 35;

/** What a page told about itself; null for a field it did not give, or gave in a form the parser does not keep. */
export interface PageMetadata {
  readonly title: string | null;
  readonly description: string | null;
  readonly siteName: string | null;
  /** The page's own canonical link, an absolute `http` or `https` URL without credentials, as text. */
  readonly canonicalUrl: string | null;
  /** A language tag such as `en` or `de-AT`. */
  readonly language: string | null;
}

export interface PageMetadataInput {
  readonly body: Uint8Array;
  /** The `Content-Type` of the response. */
  readonly contentType: string | undefined;
  /** The URL the response came from, which a relative canonical link is resolved against. */
  readonly url: string;
}

// The most meta and link tags the walk reads and the most attributes it keeps of one tag; further ones are skipped, not an error.
const MAX_META_TAGS = 1_000;
const MAX_LINK_TAGS = 200;
const MAX_ATTRIBUTES = 64;

// Elements whose content is text and not markup: nothing in it is a tag.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "xmp", "iframe", "noembed", "noframes"]);

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["sbquo", "‚"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bdquo", "„"],
  ["bull", "•"],
  ["hellip", "…"],
  ["euro", "€"],
  ["trade", "™"],
  ...(
    "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
    "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
    "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
  )
    .split(" ")
    .map((name, index): [string, string] => [name, String.fromCharCode(0xa0 + index)]),
]);

const CHARACTER_REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUN = /\s+/g;
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

const RAW_TEXT_END: Readonly<Record<string, RegExp>> = Object.fromEntries(
  [...RAW_TEXT_ELEMENTS, "title"].map((name) => [name, new RegExp(`</${name}(?=[\\s/>])`, "gi")]),
);

/** Character references are decoded once: the result of one is never read as another. A reference the parser does not know is left as written. */
function decodeCharacterReferences(text: string): string {
  return text.replace(CHARACTER_REFERENCE, (reference: string, decimal?: string, hexadecimal?: string, name?: string) => {
    if (name !== undefined) {
      return NAMED_ENTITIES.get(name) ?? reference;
    }
    const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal === undefined ? 16 : 10);
    return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? "�" : String.fromCodePoint(codePoint);
  });
}

/**
 * Plain text for a field: references decoded once, control characters removed, every run of whitespace one space, trimmed and cut to `max`
 * characters; null when nothing is left.
 */
function plainText(raw: string, max: number): string | null {
  const collapsed = decodeCharacterReferences(raw).replace(CONTROL_CHARACTERS, "").replace(WHITESPACE_RUN, " ").trim();
  if (collapsed === "") {
    return null;
  }
  // A character takes at most two code units, so the cut cannot split a pair and the array stays small.
  const cut = Array.from(collapsed.slice(0, max * 2))
    .slice(0, max)
    .join("")
    .trim();
  return cut === "" ? null : cut;
}

function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/** Whether a response of this `Content-Type` is one the parser reads. */
export function isMetadataContentType(contentType: string | undefined): boolean {
  const type = mediaTypeOf(contentType);
  return type !== undefined && METADATA_CONTENT_TYPES.includes(type);
}

const CHARSET_PARAMETER = /;\s*charset\s*=\s*"?([A-Za-z0-9_:.-]{1,40})/i;
const META_CHARSET = /<meta[^>]{0,300}?charset\s*=\s*["']?\s*([A-Za-z0-9_:.-]{1,40})/i;
const CHARSET_SNIFF_BYTES = 2048;

/** The text of the body in the character set its response names, or the first `<meta>` that names one, and UTF-8 otherwise. */
function decode(body: Uint8Array, contentType: string | undefined): string {
  let label = contentType === undefined ? undefined : CHARSET_PARAMETER.exec(contentType)?.[1];
  label ??= META_CHARSET.exec(new TextDecoder("latin1").decode(body.subarray(0, CHARSET_SNIFF_BYTES)))?.[1];
  if (label !== undefined) {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      // A label the runtime does not know is read as UTF-8, like a page that names none.
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

interface StartTag {
  readonly name: string;
  /** The first value of each attribute, by lower-case name; empty for a tag the walk has no use for. */
  readonly attributes: ReadonlyMap<string, string>;
  /** Where the tag ends, after its `>`. */
  readonly end: number;
  readonly selfClosing: boolean;
}

/**
 * Reads the start tag whose `<` is at `start`. Quoted values may hold `>`. Returns undefined when the text ends inside the tag, which ends the walk.
 * Attributes are kept only for the tags `keep` names, up to `MAX_ATTRIBUTES` of them.
 */
function readStartTag(text: string, start: number, keep: ReadonlySet<string>): StartTag | undefined {
  const length = text.length;
  let cursor = start + 1;
  while (cursor < length && !isSpace(text.charCodeAt(cursor)) && text.charCodeAt(cursor) !== 0x2f && text.charCodeAt(cursor) !== 0x3e) {
    cursor += 1;
  }
  const name = text.slice(start + 1, cursor).toLowerCase();
  const collect = keep.has(name);
  const attributes = new Map<string, string>();
  let selfClosing = false;
  for (;;) {
    selfClosing = false;
    while (cursor < length && (isSpace(text.charCodeAt(cursor)) || text.charCodeAt(cursor) === 0x2f)) {
      selfClosing = text.charCodeAt(cursor) === 0x2f;
      cursor += 1;
    }
    if (cursor >= length) {
      return undefined;
    }
    if (text.charCodeAt(cursor) === 0x3e) {
      return { name, attributes, end: cursor + 1, selfClosing };
    }
    const nameStart = cursor;
    cursor += 1;
    while (cursor < length) {
      const code = text.charCodeAt(cursor);
      if (isSpace(code) || code === 0x2f || code === 0x3e || code === 0x3d) {
        break;
      }
      cursor += 1;
    }
    const attribute = text.slice(nameStart, cursor).toLowerCase();
    let ahead = cursor;
    while (ahead < length && isSpace(text.charCodeAt(ahead))) {
      ahead += 1;
    }
    let value = "";
    if (ahead < length && text.charCodeAt(ahead) === 0x3d) {
      ahead += 1;
      while (ahead < length && isSpace(text.charCodeAt(ahead))) {
        ahead += 1;
      }
      const quote = text.charAt(ahead);
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, ahead + 1);
        if (close === -1) {
          return undefined;
        }
        value = text.slice(ahead + 1, close);
        cursor = close + 1;
      } else {
        const valueStart = ahead;
        while (ahead < length && !isSpace(text.charCodeAt(ahead)) && text.charCodeAt(ahead) !== 0x3e) {
          ahead += 1;
        }
        value = text.slice(valueStart, ahead);
        cursor = ahead;
      }
    }
    if (collect && attributes.size < MAX_ATTRIBUTES && !attributes.has(attribute)) {
      attributes.set(attribute, value);
    }
  }
}

// The `<meta>` keys the parser reads, each with the longest value it keeps.
const META_KEYS: ReadonlyMap<string, number> = new Map([
  ["og:title", METADATA_TITLE_MAX_LENGTH],
  ["og:description", METADATA_DESCRIPTION_MAX_LENGTH],
  ["description", METADATA_DESCRIPTION_MAX_LENGTH],
  ["og:site_name", METADATA_SITE_NAME_MAX_LENGTH],
  ["application-name", METADATA_SITE_NAME_MAX_LENGTH],
  ["og:locale", METADATA_LANGUAGE_MAX_LENGTH + 1],
]);

const KEPT_ATTRIBUTES: ReadonlySet<string> = new Set(["html", "meta", "link"]);

function languageOf(raw: string | undefined): string | null {
  const tag = raw === undefined ? null : plainText(raw, METADATA_LANGUAGE_MAX_LENGTH + 1);
  const normalised = tag?.replace(/_/g, "-");
  return normalised !== undefined && normalised.length <= METADATA_LANGUAGE_MAX_LENGTH && LANGUAGE_TAG.test(normalised) ? normalised : null;
}

function canonicalLinkOf(raw: string, base: string): string | null {
  const href = decodeCharacterReferences(raw).replace(CONTROL_CHARACTERS, "").trim();
  if (href === "" || !URL.canParse(href, base)) {
    return null;
  }
  const resolved = new URL(href, base);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }
  resolved.username = "";
  resolved.password = "";
  resolved.hash = "";
  return resolved.href.length <= METADATA_CANONICAL_URL_MAX_LENGTH ? resolved.href : null;
}

/** The most `<link rel=icon>` targets `parsePageIcons` returns. */
export const METADATA_ICON_LINKS_MAX = 8;

interface PageWalk {
  readonly metadata: PageMetadata;
  readonly icons: readonly string[];
}

/**
 * The one pass over the text of a page that `parsePageMetadata` and `parsePageIcons` share: the metadata fields, and the targets of the
 * `<link rel=icon>` tags in document order. Undefined when the response is not a type the parser reads.
 */
function walkPage(input: PageMetadataInput): PageWalk | undefined {
  if (!isMetadataContentType(input.contentType)) {
    return undefined;
  }
  const text = decode(input.body.subarray(0, METADATA_HTML_MAX_BYTES), input.contentType).replaceAll("\u0000", "");
  const length = text.length;

  const meta = new Map<string, string>();
  let documentTitle: string | null = null;
  let htmlLanguage: string | null = null;
  let canonical: string | null = null;
  const icons: string[] = [];
  let metaTags = 0;
  let linkTags = 0;
  let svgDepth = 0;

  let cursor = 0;
  walk: while (cursor < length) {
    const open = text.indexOf("<", cursor);
    if (open === -1) {
      break;
    }
    const next = text.charCodeAt(open + 1);
    if (next === 0x21 && text.startsWith("--", open + 2)) {
      // A comment. `<!-->` and `<!--->` are empty ones; an unclosed one runs to the end.
      if (text.startsWith(">", open + 4)) {
        cursor = open + 5;
        continue;
      }
      if (text.startsWith("->", open + 4)) {
        cursor = open + 6;
        continue;
      }
      const close = text.indexOf("-->", open + 4);
      if (close === -1) {
        break;
      }
      cursor = close + 3;
      continue;
    }
    if (next === 0x21 || next === 0x3f || next === 0x2f) {
      // A doctype, a processing instruction, a CDATA section or an end tag: nothing in it is read, except that an end tag closes an SVG.
      const close = text.indexOf(">", open + 2);
      if (close === -1) {
        break;
      }
      if (next === 0x2f && svgDepth > 0 && /^svg[\s/>]/i.test(text.slice(open + 2, open + 6))) {
        svgDepth -= 1;
      }
      cursor = close + 1;
      continue;
    }
    if (!isLetter(next)) {
      cursor = open + 1;
      continue;
    }

    const tag = readStartTag(text, open, KEPT_ATTRIBUTES);
    if (tag === undefined) {
      break;
    }
    cursor = tag.end;

    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      const end = RAW_TEXT_END[tag.name];
      if (end === undefined) {
        break;
      }
      end.lastIndex = cursor;
      const closing = end.exec(text);
      if (closing === null) {
        break;
      }
      cursor = closing.index;
      continue;
    }
    switch (tag.name) {
      case "title": {
        if (documentTitle !== null || svgDepth > 0) {
          break;
        }
        const end = RAW_TEXT_END["title"];
        if (end === undefined) {
          break;
        }
        end.lastIndex = cursor;
        const closing = end.exec(text);
        if (closing === null) {
          // A title that is never closed takes the rest of the page, as in a browser; nothing after it is read, and no later search repeats this one.
          break walk;
        }
        documentTitle = plainText(text.slice(cursor, closing.index), METADATA_TITLE_MAX_LENGTH);
        cursor = closing.index;
        break;
      }
      case "svg":
        if (!tag.selfClosing) {
          svgDepth += 1;
        }
        break;
      case "html":
        htmlLanguage ??= languageOf(tag.attributes.get("lang") ?? tag.attributes.get("xml:lang"));
        break;
      case "meta": {
        metaTags += 1;
        if (metaTags > MAX_META_TAGS) {
          break;
        }
        const content = tag.attributes.get("content");
        if (content === undefined) {
          break;
        }
        for (const key of [tag.attributes.get("property"), tag.attributes.get("name")]) {
          const wanted = key?.trim().toLowerCase();
          if (wanted !== undefined && !meta.has(wanted) && META_KEYS.has(wanted)) {
            const limit = META_KEYS.get(wanted) ?? 0;
            const value = plainText(content, limit);
            if (value !== null) {
              meta.set(wanted, value);
            }
          }
        }
        break;
      }
      case "link": {
        linkTags += 1;
        const rel = tag.attributes.get("rel");
        const href = tag.attributes.get("href");
        if (linkTags > MAX_LINK_TAGS || rel === undefined || href === undefined) {
          break;
        }
        const tokens = rel.toLowerCase().split(/\s+/);
        if (canonical === null && tokens.includes("canonical")) {
          canonical = canonicalLinkOf(href, input.url);
        }
        if (icons.length < METADATA_ICON_LINKS_MAX && tokens.includes("icon")) {
          const target = canonicalLinkOf(href, input.url);
          if (target !== null && !icons.includes(target)) {
            icons.push(target);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    metadata: {
      title: meta.get("og:title") ?? documentTitle,
      description: meta.get("og:description") ?? meta.get("description") ?? null,
      siteName: meta.get("og:site_name") ?? meta.get("application-name") ?? null,
      canonicalUrl: canonical,
      language: htmlLanguage ?? languageOf(meta.get("og:locale")),
    },
    icons,
  };
}

/**
 * The metadata of an HTML page: the title from `og:title`, then `<title>`; the description from `og:description`, then
 * `<meta name="description">`; the site name from `og:site_name`, then `application-name`; the canonical link; and the language from
 * `<html lang>`, then `og:locale`. A value that is empty once cleaned counts as absent, so the next source is tried. Undefined when the response
 * is not a type the parser reads. Only the first `METADATA_HTML_MAX_BYTES` bytes are looked at.
 */
export function parsePageMetadata(input: PageMetadataInput): PageMetadata | undefined {
  return walkPage(input)?.metadata;
}

/**
 * The addresses the `<link>` tags of an HTML page with `rel=icon` (also `shortcut icon`) name, in document order, at most `METADATA_ICON_LINKS_MAX`:
 * absolute `http` and `https` addresses, resolved against the page's own address, without credentials or fragment and without duplicates. The
 * addresses are text and nothing here fetches them. Empty when the response is not a type the parser reads. The same bounded walk as
 * `parsePageMetadata`, over the first `METADATA_HTML_MAX_BYTES` bytes.
 */
export function parsePageIcons(input: PageMetadataInput): readonly string[] {
  return walkPage(input)?.icons ?? [];
}
