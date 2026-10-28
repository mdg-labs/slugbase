import { describe, expect, it } from "vitest";
import {
  METADATA_CANONICAL_URL_MAX_LENGTH,
  METADATA_DESCRIPTION_MAX_LENGTH,
  METADATA_HTML_MAX_BYTES,
  METADATA_LANGUAGE_MAX_LENGTH,
  METADATA_SITE_NAME_MAX_LENGTH,
  METADATA_TITLE_MAX_LENGTH,
  METADATA_ICON_LINKS_MAX,
  isMetadataContentType,
  parsePageIcons,
  parsePageMetadata,
  type PageMetadata,
} from "../../src/index.ts";

// The parser reads untrusted pages (doc 10 T13): every value is bounded plain text, nothing is executed or followed, and the work stays in
// proportion to the input. The pages below are the hostile shapes of the failure scenario, and each is held to its time as well as its answer.

const URL_OF_PAGE = "https://example.test/articles/one";
const EMPTY: PageMetadata = { title: null, description: null, siteName: null, canonicalUrl: null, language: null };

function parse(html: string | Uint8Array, contentType: string | undefined = "text/html; charset=utf-8"): PageMetadata {
  const body = typeof html === "string" ? new TextEncoder().encode(html) : html;
  const parsed = parsePageMetadata({ body, contentType, url: URL_OF_PAGE });
  if (parsed === undefined) {
    throw new Error("the page was not parsed");
  }
  return parsed;
}

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

const TIME_BUDGET_MS = 1_000;

describe("parsePageMetadata, what a page says about itself", () => {
  it("reads the title, description, site name, canonical link and language of a page", () => {
    const page = parse(`<!doctype html><html lang="de-AT"><head>
      <title>The Title</title>
      <meta name="description" content="A page about things.">
      <meta property="og:site_name" content="Example">
      <link rel="canonical" href="/articles/1?utm_source=x">
    </head><body>Hello</body></html>`);

    expect(page).toEqual({
      title: "The Title",
      description: "A page about things.",
      siteName: "Example",
      canonicalUrl: "https://example.test/articles/1?utm_source=x",
      language: "de-AT",
    });
  });

  it("prefers og:title and og:description to the title and the description, whatever their order in the page", () => {
    const page = parse(`<title>Plain</title><meta name="description" content="Plain description"><meta property="og:description" content="Open description"><meta property="og:title" content="Open title">`);

    expect(page).toMatchObject({ title: "Open title", description: "Open description" });
  });

  it("falls back to the next source when the preferred one is empty once cleaned", () => {
    const page = parse(`<meta property="og:title" content="  \u0007 "><meta name="og:title" content=""><title>Fallback</title><meta name="description" content="x">`);

    expect(page.title).toBe("Fallback");
  });

  it("takes the first value of a field when the page gives it twice", () => {
    expect(parse(`<title>First</title><title>Second</title>`).title).toBe("First");
    expect(parse(`<meta property="og:title" content="One"><meta property="og:title" content="Two">`).title).toBe("One");
  });

  it("matches tags, attributes and meta keys without regard to case, and takes single, double and no quotes", () => {
    const page = parse(`<HTML LANG=en><META NAME='Description' CONTENT='Quoted'><META PROPERTY=og:site_name CONTENT=Bare><TITLE>Upper</TITLE>`);

    expect(page).toEqual({ ...EMPTY, title: "Upper", description: "Quoted", siteName: "Bare", language: "en" });
  });

  it("falls back to og:locale for the language and to application-name for the site name", () => {
    const page = parse(`<meta property="og:locale" content="de_DE"><meta name="application-name" content="Tool">`);

    expect(page).toMatchObject({ language: "de-DE", siteName: "Tool" });
  });

  it("decodes character references once", () => {
    const page = parse(`<title>Tom &amp; Jerry &lt;3 &auml;&Ouml;&#252; &#x1F600; &amp;lt;b&amp;gt; &unknown; &#0; &#xD800;</title>`);

    expect(page.title).toBe("Tom & Jerry <3 äÖü \u{1F600} &lt;b&gt; &unknown; � �");
  });

  it("removes control characters and collapses whitespace", () => {
    const page = parse(`<title>\n  A\t\u0001B\u0000C\u007f\u0085  \r\n  D&#8;E&nbsp;&nbsp;F   G </title>`);

    expect(page.title).toBe("A BC DE F G");
  });

  it("cuts every value to the limit of its field, by character", () => {
    const long = "\u{1F600}".repeat(5_000);
    const page = parse(
      `<title>${long}</title><meta name="description" content="${long}"><meta property="og:site_name" content="${long}"><link rel="canonical" href="https://example.test/${"a".repeat(METADATA_CANONICAL_URL_MAX_LENGTH)}">`,
    );

    expect(Array.from(page.title ?? "")).toHaveLength(METADATA_TITLE_MAX_LENGTH);
    expect(Array.from(page.description ?? "")).toHaveLength(METADATA_DESCRIPTION_MAX_LENGTH);
    expect(Array.from(page.siteName ?? "")).toHaveLength(METADATA_SITE_NAME_MAX_LENGTH);
    expect(page.canonicalUrl).toBeNull();
  });

  it("keeps a title that holds markup as the text it is", () => {
    const page = parse(`<title>x <img src=x onerror=alert(1)> y</title>`);

    expect(page.title).toBe("x <img src=x onerror=alert(1)> y");
  });

  it("ignores script, style, comment and textarea content", () => {
    const page = parse(`<head>
      <script>var t = "<title>Script</title><meta property='og:title' content='Script'>";</script>
      <style>/* <title>Style</title> */ a::before { content: "<title>Style</title>" }</style>
      <!-- <title>Comment</title><meta property="og:title" content="Comment"> -->
      <textarea><title>Area</title></textarea>
      <SCRIPT type="x">1</SCRIPT >
      <title>Real</title></head>`);

    expect(page).toEqual({ ...EMPTY, title: "Real" });
  });

  it("ignores a title inside an SVG", () => {
    const page = parse(`<body><svg viewBox="0 0 1 1"><title>Icon</title></svg><title>Real</title>`);

    expect(page.title).toBe("Real");
  });

  it("reads an attribute value that holds a closing angle bracket", () => {
    const page = parse(`<meta name="description" content="a > b"><title>T</title>`);

    expect(page).toMatchObject({ title: "T", description: "a > b" });
  });

  it("reads the page in the character set its response names, or its meta tag names", () => {
    const latin1 = Uint8Array.from([...new TextEncoder().encode("<title>"), 0xe4, 0xf6, ...new TextEncoder().encode("</title>")]);

    expect(parse(latin1, "text/html; charset=iso-8859-1").title).toBe("äö");
    expect(parse(Uint8Array.from([...new TextEncoder().encode('<meta charset="windows-1252">'), ...latin1]), "text/html").title).toBe("äö");
    expect(parse(latin1, "text/html; charset=no-such-set").title).toBe("��");
    for (const tag of ["<meta charset=windows-1252>", "<meta charset = \" windows-1252\">", "<meta charset=\t'\twindows-1252'>", '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">']) {
      expect(parse(Uint8Array.from([...new TextEncoder().encode(tag), ...latin1]), "text/html").title).toBe("äö");
    }
  });

  it("reads application/xhtml+xml and no other type", () => {
    expect(parse("<title>X</title>", "application/xhtml+xml").title).toBe("X");
    expect(parse("<title>X</title>", "TEXT/HTML").title).toBe("X");
    for (const type of ["text/plain", "application/json", "image/svg+xml", "application/pdf", "", undefined]) {
      expect(parsePageMetadata({ body: new TextEncoder().encode("<title>X</title>"), contentType: type, url: URL_OF_PAGE })).toBeUndefined();
      expect(isMetadataContentType(type)).toBe(false);
    }
  });
});

describe("the canonical link", () => {
  const canonicalOf = (href: string): string | null => parse(`<link rel="canonical" href="${href}">`).canonicalUrl;

  it("is an absolute http or https URL, resolved against the page, without credentials and fragment", () => {
    expect(canonicalOf("https://example.test/a#frag")).toBe("https://example.test/a");
    expect(canonicalOf("../b")).toBe("https://example.test/b");
    expect(canonicalOf("//other.test/c")).toBe("https://other.test/c");
    expect(canonicalOf("https://user:secret@example.test/d")).toBe("https://example.test/d");
    expect(canonicalOf("http://example.test/a&amp;b")).toBe("http://example.test/a&b");
  });

  it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:x", "ftp://example.test/", "", "http://"])("is not kept for %s", (href) => {
    expect(canonicalOf(href)).toBeNull();
  });

  it("is read from a rel with several words and from no other link", () => {
    expect(parse(`<link rel="alternate canonical" href="/x">`).canonicalUrl).toBe("https://example.test/x");
    expect(parse(`<link rel="icon" href="/x"><link rel="stylesheet" href="/y"><link href="/z">`).canonicalUrl).toBeNull();
  });

  it("is never requested: the parser has no network and reads the text of the link only", () => {
    // A page that names an internal address as its canonical keeps it as text, as it would any other; nothing resolves or connects.
    expect(canonicalOf("http://169.254.169.254/latest/meta-data/")).toBe("http://169.254.169.254/latest/meta-data/");
  });
});

describe("the language", () => {
  it.each([
    ["en", "en"],
    ["de-AT", "de-AT"],
    ["zh_Hant_TW", "zh-Hant-TW"],
    ["x-klingon-tlh", null],
    ["<b>", null],
    ["en-US" + "-x".repeat(METADATA_LANGUAGE_MAX_LENGTH), null],
    ["", null],
  ])("keeps %j as %j", (lang, expected) => {
    expect(parse(`<html lang="${lang}">`).language).toBe(expected);
  });
});

describe("pages that try to hurt the parser", () => {
  const hostile: [string, () => string][] = [
    ["a head of 10 MB", () => `<html><head>${'<meta name="x" content="y">'.repeat(400_000)}<title>Late</title></head>`],
    ["a title that is never closed", () => `<title>${"a".repeat(600_000)}`],
    ["many titles that are never closed", () => "<title>".repeat(80_000)],
    ["many titles with text that are never closed", () => "<title>x".repeat(80_000)],
    ["many scripts, styles and textareas that are never closed", () => "<script><style><textarea><title>".repeat(20_000)],
    ["many title tags after a title that is empty", () => "<title></title>".repeat(30_000) + "<title>".repeat(30_000)],
    ["tags that are never closed", () => "<a ".repeat(200_000)],
    ["an attribute quote that is never closed", () => `<meta name="description" content="${"x".repeat(600_000)}`],
    ["a flood of nested meta tags", () => "<meta ".repeat(100_000) + '<meta property="og:title" content="Flood">'.repeat(100_000)],
    ["a flood of link tags", () => '<link rel="canonical" href="javascript:1">'.repeat(50_000)],
    ["a flood of attributes", () => `<meta ${"a=b ".repeat(200_000)} name="description" content="d">`],
    ["a flood of angle brackets", () => "<".repeat(600_000) + "<<>>".repeat(100_000)],
    ["a flood of comments", () => "<!--".repeat(200_000)],
    ["a flood of script elements", () => "<script></script>".repeat(30_000) + "<title>After</title>"],
    ["an unclosed script", () => `<script>${"<title>x</title>".repeat(30_000)}`],
    ["an entity bomb", () => `<title>${"&amp;".repeat(100_000)}&#x${"0".repeat(100)}41;${"&".repeat(200_000)}</title>`],
    ["references to the largest code points", () => `<title>${"&#1114111;&#99999999;&#xFFFFFFFF;".repeat(20_000)}</title>`],
    ["a million whitespace characters", () => `<title>${" \n\t".repeat(200_000)}x${" ".repeat(100_000)}</title>`],
    ["NUL bytes everywhere", () => `<ti\u0000tle>A\u0000B</ti\u0000tle>${"\u0000".repeat(300_000)}`],
    ["deeply nested svg", () => "<svg>".repeat(100_000) + "<title>Inner</title>"],
    ["a charset meta tag followed by a run of whitespace", () => `<meta charset=${"\t".repeat(600_000)}`],
  ];

  it.each(hostile)("ends %s as bounded plain text, in time", (_name, build) => {
    const body = new TextEncoder().encode(build());
    expect(body.length).toBeGreaterThan(100_000);

    const { value, ms } = timed(() => parsePageMetadata({ body, contentType: "text/html", url: URL_OF_PAGE }));

    expect(ms).toBeLessThan(TIME_BUDGET_MS);
    expect(value).toBeDefined();
    for (const [field, limit] of [
      ["title", METADATA_TITLE_MAX_LENGTH],
      ["description", METADATA_DESCRIPTION_MAX_LENGTH],
      ["siteName", METADATA_SITE_NAME_MAX_LENGTH],
      ["canonicalUrl", METADATA_CANONICAL_URL_MAX_LENGTH],
      ["language", METADATA_LANGUAGE_MAX_LENGTH],
    ] as const) {
      const text = value?.[field];
      if (text !== null && text !== undefined) {
        expect(Array.from(text).length).toBeLessThanOrEqual(limit);
        expect(text).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/);
      }
    }
  });

  it("keeps what it read before an unclosed tag ends the walk", () => {
    const page = parse(`<title>Kept</title><meta name="description" content="Kept too"><meta property="og:site_name" content="never closed`);

    expect(page).toEqual({ ...EMPTY, title: "Kept", description: "Kept too" });
  });

  it("reads only the first 512 KiB of the body", () => {
    const padding = " ".repeat(METADATA_HTML_MAX_BYTES - 20);
    const inside = parse(`${padding}<title>In</title>`);
    const beyond = parse(`${padding}${" ".repeat(100)}<title>Out</title>`);

    expect(inside.title).toBe("In");
    expect(beyond.title).toBeNull();
  });

  it("reads at most 1 000 meta tags", () => {
    const filler = '<meta name="x" content="y">'.repeat(1_000);

    expect(parse(`${filler}<meta name="description" content="late">`).description).toBeNull();
    expect(parse(`${'<meta name="x" content="y">'.repeat(999)}<meta name="description" content="in time">`).description).toBe("in time");
  });

  it("does not execute or interpret a title that is an HTML payload", () => {
    const page = parse(`<title>&lt;img src=x onerror=alert(1)&gt;<img src=x onerror=alert(2)></title>`);

    expect(page.title).toBe("<img src=x onerror=alert(1)><img src=x onerror=alert(2)>");
  });
});

describe("parsePageIcons", () => {
  const page = (head: string, url = "https://example.test/dir/page"): Parameters<typeof parsePageIcons>[0] => ({
    body: new TextEncoder().encode(`<html><head>${head}</head></html>`),
    contentType: "text/html",
    url,
  });

  it("returns the rel=icon and rel=shortcut icon targets in document order, resolved against the page, without duplicates", () => {
    expect(
      parsePageIcons(
        page(
          '<link rel="stylesheet" href="/a.css"><link rel="ICON" href="a.png"><link rel="shortcut icon" href="/b.ico"><link rel="icon" href="a.png"><link rel="apple-touch-icon" href="/c.png"><link rel="mask-icon" href="/d.svg">',
        ),
      ),
    ).toEqual(["https://example.test/dir/a.png", "https://example.test/b.ico"]);
  });

  it("keeps only http and https addresses, drops credentials and the fragment, and keeps the canonical link beside them", () => {
    const input = page(
      '<link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="//user:pw@cdn.test/i.png#frag"><link rel="canonical" href="/canon">',
    );
    expect(parsePageIcons(input)).toEqual(["https://cdn.test/i.png"]);
    expect(parsePageMetadata(input)?.canonicalUrl).toBe("https://example.test/canon");
  });

  it("returns at most eight, skips links inside comments, scripts and svg, and nothing for a type it does not read", () => {
    const many = Array.from({ length: 12 }, (_, index) => `<link rel="icon" href="/i${String(index)}.png">`).join("");
    expect(parsePageIcons(page(many))).toHaveLength(METADATA_ICON_LINKS_MAX);
    expect(parsePageIcons(page('<!-- <link rel="icon" href="/c.png"> --><script>var x = \'<link rel="icon" href="/s.png">\';</script>'))).toEqual([]);
    expect(parsePageIcons({ ...page('<link rel="icon" href="/i.png">'), contentType: "image/svg+xml" })).toEqual([]);
  });
});
