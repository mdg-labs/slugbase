import { normalizeBookmarkUrl } from "@slugbase/core";
import type { Random } from "./random.ts";

// The bookmarks of the development instance (doc 08 section 1.4, doc 02 section 5.1): the shapes that break a list, a
// modal or a screen reader, followed by realistic filler. Every value is within what the `bookmarks` table accepts
// (a title of 1 to 300 characters, a description of at most 1 000, a URL of at most 2 048) and counts characters as
// the database does, in code points.

const DAY_MS = 86_400_000;

/** A bookmark as the seed writes it: the stored columns, including the usage the application role may not set. */
export interface SeedBookmark {
  readonly id: string;
  readonly ownerId: string;
  readonly url: string;
  readonly urlCanonical: string;
  readonly host: string;
  readonly title: string;
  readonly description: string | null;
  readonly pinnedAt: Date | null;
  readonly openCount: number;
  readonly lastOpenedAt: Date | null;
  readonly createdAt: Date;
  /** The private slug of the bookmark, when the seed gives it one. */
  readonly slug?: string | null;
  /** Whether `/go/<slug>` forwards to it; only a bookmark with a slug does. */
  readonly forwarding?: boolean;
}

/** The named shapes every bookmark list of the seed starts with. */
export const BOOKMARK_SHAPE_NAMES = [
  "longest-title",
  "unbreakable-title",
  "single-character-title",
  "rtl-arabic",
  "rtl-hebrew",
  "mixed-direction",
  "emoji",
  "emoji-only",
  "markup-title",
  "markup-description",
  "markup-entities",
  "pinned-opened",
  "pinned-unopened",
  "opened-often",
  "never-opened",
  "duplicate-canonical-a",
  "duplicate-canonical-b",
  "duplicate-canonical-c",
] as const;

export type BookmarkShapeName = (typeof BOOKMARK_SHAPE_NAMES)[number];

export interface BookmarkContext {
  readonly random: Random;
  readonly ids: () => string;
  /** The accounts that own bookmarks; each bookmark is given one of them. */
  readonly owners: readonly string[];
  /** The moment the seed treats as now, so creation and open times are the same on every run. */
  readonly now: Date;
}

interface Fields {
  readonly url: string;
  readonly title: string;
  readonly description?: string | null;
  readonly pinned?: boolean;
  readonly openCount?: number;
  readonly lastOpened?: "recent" | "random";
}

/** The first `max` code points of `text`: the unit the database counts in. */
function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

function repeatedTo(text: string, length: number): string {
  return clip(text.repeat(Math.ceil(length / text.length)), length);
}

const ARABIC_TITLE = "دليل المستخدم لإدارة الإشارات المرجعية";
const HEBREW_TITLE = "מדריך למשתמש לניהול סימניות";
const EMOJI_TITLE = "🚀 Launch checklist 🎉 👨‍👩‍👧‍👦 🇩🇪 👍🏽";
const MARKUP = "<img src=x onerror=alert(1)>";
const MARKUP_DESCRIPTION = `${MARKUP} <script>alert(1)</script> "><svg onload=alert(1)> javascript:alert(1)`;
const LONG_PATH = "/long-path-segment-".repeat(100);

function create(context: BookmarkContext, fields: Fields): SeedBookmark {
  const { random } = context;
  const normalised = normalizeBookmarkUrl(fields.url);
  if (!normalised.ok) {
    throw new Error(`the seed built a URL the application refuses (${normalised.reason}): ${fields.url.slice(0, 80)}`);
  }
  const createdAt = new Date(context.now.getTime() - random.int(400) * DAY_MS - random.int(DAY_MS));
  const opened = (fields.openCount ?? 0) > 0;
  const lastOpenedAt = !opened
    ? null
    : fields.lastOpened === "recent"
      ? new Date(context.now.getTime() - random.int(3_600_000))
      : new Date(createdAt.getTime() + random.int(context.now.getTime() - createdAt.getTime()));
  return {
    id: context.ids(),
    ownerId: random.pick(context.owners),
    url: normalised.value.url,
    urlCanonical: normalised.value.canonical,
    host: normalised.value.host,
    title: fields.title,
    description: fields.description ?? null,
    pinnedAt: fields.pinned === true ? new Date(createdAt.getTime() + random.int(DAY_MS)) : null,
    openCount: fields.openCount ?? 0,
    lastOpenedAt,
    createdAt,
  };
}

// The URLs of the three duplicate rows differ in case, port, trailing slash, parameter order, tracking parameters and
// fragment, and have one canonical form (doc 02 section 5.1).
const DUPLICATE_URLS = {
  a: "https://example.com/read?b=2&a=1",
  b: "https://EXAMPLE.com/read/?a=1&b=2&utm_source=newsletter#top",
  c: "https://example.com:443/read?a=1&b=2&fbclid=seed",
} as const;

function shapeFields(name: BookmarkShapeName): Fields {
  switch (name) {
    case "longest-title":
      return {
        url: `https://example.com${repeatedTo(LONG_PATH, 2000 - "https://example.com".length)}`,
        title: repeatedTo("A title that runs to the limit of three hundred characters. ", 300),
        description: repeatedTo("A description that runs to the limit of a thousand characters. ", 1000),
        openCount: 3,
      };
    case "unbreakable-title":
      return { url: "https://example.com/unbreakable", title: "W".repeat(300), description: "N".repeat(1000) };
    case "single-character-title":
      return { url: "https://example.com/one", title: "x" };
    case "rtl-arabic":
      return { url: "https://example.com/ar", title: ARABIC_TITLE, description: "وصف الإشارة المرجعية باللغة العربية.", openCount: 12 };
    case "rtl-hebrew":
      return { url: "https://example.com/he", title: HEBREW_TITLE, description: "תיאור הסימנייה בעברית." };
    case "mixed-direction":
      return { url: "https://example.com/mixed", title: `SlugBase ${ARABIC_TITLE} (2026) ${HEBREW_TITLE} 123` };
    case "emoji":
      return { url: "https://example.com/emoji", title: EMOJI_TITLE, description: "🧪 emoji, ZWJ sequences, flags and skin tones", openCount: 5 };
    case "emoji-only":
      return { url: "https://example.com/emoji-only", title: "🔥🔥🔥" };
    case "markup-title":
      return { url: "https://example.com/markup-title", title: MARKUP, description: MARKUP_DESCRIPTION, openCount: 2 };
    case "markup-description":
      return { url: "https://example.com/markup-description", title: "An ordinary title", description: MARKUP_DESCRIPTION };
    case "markup-entities":
      return { url: "https://example.com/markup-entities", title: "&lt;b&gt;bold&lt;/b&gt; &amp; <b>bold</b> {{7*7}}", description: "&#60;i&#62; &quot;quoted&quot; <i>italic</i>" };
    case "pinned-opened":
      return { url: "https://example.com/pinned-opened", title: "Pinned and opened", pinned: true, openCount: 42, lastOpened: "recent" };
    case "pinned-unopened":
      return { url: "https://example.com/pinned-unopened", title: "Pinned and never opened", pinned: true };
    case "opened-often":
      return { url: "https://example.com/opened-often", title: "Opened a million times", openCount: 1_234_567, lastOpened: "recent" };
    case "never-opened":
      return { url: "https://example.com/never-opened", title: "Never opened" };
    case "duplicate-canonical-a":
      return { url: DUPLICATE_URLS.a, title: "Duplicate canonical URL (plain)", openCount: 1 };
    case "duplicate-canonical-b":
      return { url: DUPLICATE_URLS.b, title: "Duplicate canonical URL (tracking and fragment)" };
    case "duplicate-canonical-c":
      return { url: DUPLICATE_URLS.c, title: "Duplicate canonical URL (default port)", description: "The third URL with this canonical form." };
  }
}

/** One bookmark of every named shape, with the owners, ids and times of `context`. */
export function bookmarkShapes(context: BookmarkContext): readonly { readonly name: BookmarkShapeName; readonly bookmark: SeedBookmark }[] {
  return BOOKMARK_SHAPE_NAMES.map((name) => ({ name, bookmark: create(context, shapeFields(name)) }));
}

const SITES = ["example.com", "example.org", "example.net", "docs.example.com", "blog.example.org", "wiki.example.net", "dev.example.com", "news.example.org"];
const ADJECTIVES = ["Practical", "Complete", "Short", "Annotated", "Illustrated", "Honest", "Quick", "Deep"];
const TOPICS = ["caching", "keyboard shortcuts", "database indexes", "typography", "accessibility", "release notes", "queues", "migrations", "sync engines", "color systems"];
const KINDS = ["guide", "notes", "reference", "tutorial", "checklist", "comparison", "walkthrough"];
const SENTENCES = [
  "A walkthrough with worked examples.",
  "Collected notes, kept short on purpose.",
  "Worth reading before the next review.",
  "The reference everyone links to.",
  "Includes a section on common mistakes.",
];

function filler(context: BookmarkContext, index: number, earlier: readonly string[]): SeedBookmark {
  const { random } = context;
  const text = `${random.pick(ADJECTIVES)} ${random.pick(KINDS)} to ${random.pick(TOPICS)}`;
  const roll = random.next();
  const title = roll < 0.03 ? `${random.pick(["🔖", "📚", "⭐", "🛠️"])} ${text}` : roll < 0.05 ? random.pick([ARABIC_TITLE, HEBREW_TITLE]) : text;
  const reused = earlier.length > 0 && random.chance(0.02) ? random.pick(earlier) : undefined;
  const slug = text.toLowerCase().replaceAll(" ", "-");
  const url = reused === undefined ? `https://${random.pick(SITES)}/${slug}-${String(index)}` : `${reused}${reused.includes("?") ? "&" : "?"}utm_medium=seed`;
  const opened = random.chance(0.55);
  return create(context, {
    url,
    title,
    description: random.chance(0.7) ? `${random.pick(SENTENCES)} ${random.pick(SENTENCES)}` : null,
    pinned: random.chance(0.04),
    openCount: opened ? 1 + random.int(500) : 0,
    lastOpened: "random",
  });
}

/** `count` bookmarks: the named shapes first, then filler with the same mix of pinned, opened and duplicate rows. */
export function buildBookmarks(count: number, context: BookmarkContext): SeedBookmark[] {
  const shapes = bookmarkShapes(context).map((shape) => shape.bookmark);
  const bookmarks = shapes.slice(0, count);
  const earlier: string[] = [];
  for (let index = bookmarks.length; index < count; index += 1) {
    const bookmark = filler(context, index, earlier);
    earlier.push(bookmark.url);
    bookmarks.push(bookmark);
  }
  return bookmarks;
}
