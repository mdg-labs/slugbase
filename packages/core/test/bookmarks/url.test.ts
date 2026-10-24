import { describe, expect, it } from "vitest";
import { BOOKMARK_URL_MAX_LENGTH, normalizeBookmarkUrl, type BookmarkUrlRefusal } from "../../src/index.ts";

function accepted(input: string) {
  const result = normalizeBookmarkUrl(input);
  if (!result.ok) {
    throw new Error(`${JSON.stringify(input)} was refused as ${result.reason}`);
  }
  return result.value;
}

function refusal(input: string): BookmarkUrlRefusal {
  const result = normalizeBookmarkUrl(input);
  if (result.ok) {
    throw new Error(`${JSON.stringify(input)} was accepted as ${result.value.url}`);
  }
  return result.reason;
}

describe("normalizeBookmarkUrl, the URL as stored", () => {
  it.each([
    ["HTTPS://Example.COM/Path?Q=1", "https://example.com/Path?Q=1"],
    ["http://EXAMPLE.com", "http://example.com/"],
    ["http://example.com:80/a", "http://example.com/a"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["https://example.com:80/a", "https://example.com:80/a"],
    ["http://example.com:443/a", "http://example.com:443/a"],
    ["http://example.com:8080/a", "http://example.com:8080/a"],
    ["https://example.com/a/./b/../c", "https://example.com/a/c"],
    ["https://example.com/a b", "https://example.com/a%20b"],
  ])("lower-cases the scheme and host and removes the default port of %s", (input, stored) => {
    expect(accepted(input).url).toBe(stored);
  });

  it("keeps the fragment, the tracking parameters and the order of the parameters", () => {
    expect(accepted("https://example.com/a?utm_source=x&b=2&a=1#section-2").url).toBe("https://example.com/a?utm_source=x&b=2&a=1#section-2");
  });

  it("drops whitespace around the value and nothing inside it", () => {
    expect(accepted("  \thttps://example.com/\n").url).toBe("https://example.com/");
  });

  it.each([
    ["https://bücher.example/straße", "https://xn--bcher-kva.example/stra%C3%9Fe"],
    ["https://日本語.jp/", "https://xn--wgv71a119e.jp/"],
    ["https://Bücher.Example/", "https://xn--bcher-kva.example/"],
    ["https://münchen.de:443/", "https://xn--mnchen-3ya.de/"],
    ["https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/"],
  ])("converts an internationalised host name of %s to punycode", (input, stored) => {
    expect(accepted(input).url).toBe(stored);
  });

  it("stores what the URL standard makes of extra slashes after the scheme, which is still an http URL", () => {
    expect(accepted("https:///example.com/a").url).toBe("https://example.com/a");
  });

  it("keeps the credentials, the port and the bracketed address of an IPv6 host in the stored form", () => {
    expect(accepted("http://ada:secret@example.com:8080/").url).toBe("http://ada:secret@example.com:8080/");
    expect(accepted("http://[2001:DB8::1]:8080/x").url).toBe("http://[2001:db8::1]:8080/x");
  });
});

describe("normalizeBookmarkUrl, the canonical form and the host", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com/a/b/", "https://example.com/a/b"],
    ["https://example.com/a//", "https://example.com/a"],
    ["HTTPS://EXAMPLE.com:443/a/#frag", "https://example.com/a"],
    ["http://example.com:8080/a/", "http://example.com:8080/a"],
    ["https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2"],
    ["https://example.com/a?b=2&a=2&a=1", "https://example.com/a?a=1&a=2&b=2"],
    ["https://example.com/a?utm_source=x&utm_medium=y&a=1&UTM_Campaign=z", "https://example.com/a?a=1"],
    ["https://example.com/a?fbclid=abc&gclid=def&a=1", "https://example.com/a?a=1"],
    ["https://example.com/a?FBCLID=abc&GClid=def", "https://example.com/a"],
    ["https://example.com/?utm_source=x", "https://example.com"],
    ["https://example.com/a?utm=1&utmx=2&xutm_a=3&fbclidx=4", "https://example.com/a?fbclidx=4&utm=1&utmx=2&xutm_a=3"],
    ["https://example.com/a?b&a=1&&c=", "https://example.com/a?a=1&b&c="],
    ["https://example.com/a?q=a%20b&p=c+d", "https://example.com/a?p=c+d&q=a%20b"],
    ["https://ada:secret@example.com/a", "https://example.com/a"],
    ["https://bücher.example/a/?utm_source=x#top", "https://xn--bcher-kva.example/a"],
    ["https://example.com/a?x=1#utm_source=2", "https://example.com/a?x=1"],
  ])("computes the canonical form of %s", (input, canonical) => {
    expect(accepted(input).canonical).toBe(canonical);
  });

  it("gives two spellings of one page the same canonical form and a page with another parameter a different one", () => {
    const a = accepted("HTTPS://Example.com:443/docs/?b=2&a=1&utm_source=newsletter#intro").canonical;
    const b = accepted("https://example.com/docs?a=1&b=2&fbclid=x").canonical;
    const c = accepted("https://example.com/docs?a=1&b=3").canonical;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it.each([
    ["https://Example.COM/a", "example.com"],
    ["https://example.com:8443/a", "example.com"],
    ["https://ada:secret@example.com/", "example.com"],
    ["https://日本語.jp/", "xn--wgv71a119e.jp"],
    ["http://[2001:db8::1]:8080/", "[2001:db8::1]"],
    ["http://192.168.0.1/", "192.168.0.1"],
    ["http://0x7f.1/", "127.0.0.1"],
  ])("derives the host of %s", (input, host) => {
    expect(accepted(input).host).toBe(host);
  });

  it("derives the host from the canonical form", () => {
    for (const input of ["https://Example.COM:8443/a/?utm_source=x", "https://ada:secret@bücher.example/#f"]) {
      const { canonical, host } = accepted(input);
      expect(new URL(canonical).hostname).toBe(host);
    }
  });
});

describe("normalizeBookmarkUrl, what it refuses (doc 10 T12 and T13)", () => {
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(document.cookie)",
    "\tjava\tscript:alert(1)",
    "javascript://example.com/%0Aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "file:///etc/passwd",
    "FILE://localhost/etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://example.com/0192f3a0",
    "ftp://example.com/file",
    "ws://example.com/",
    "about:blank",
    "mailto:ada@example.test",
    "chrome://settings",
    "view-source:https://example.com/",
  ])("refuses the scheme of %j", (input) => {
    expect(refusal(input)).toBe("not_http");
  });

  it.each(["//example.com/a", "///example.com", "example.com", "www.example.com/a", "/a/b", "?q=1", "#fragment", "http:example.com", "http:/example.com", "http:\\\\example.com", "https:example.com", "hxxp://example.com"])(
    "refuses %j, which does not begin with http:// or https://",
    (input) => {
      expect(refusal(input)).toBe("not_http");
    },
  );

  it.each(["", " ", "\t\n\r ", "\u0000"])("refuses the empty value %j", (input) => {
    expect(refusal(input)).toBe(input === "\u0000" ? "not_http" : "empty");
  });

  it.each([
    "http://",
    "https://",
    "https://exa mple.com/",
    "https://exa\tmple.com/",
    "https://example.com/a\nb",
    "https://example.com/\u0000",
    "https://example.com/\u007f",
    "https://exa<mple.com/",
    "https://exa|mple.com/",
    "https://[::1/",
    "https://example.com:99999/",
    "https://example.com:port/",
    "https://256.256.256.256/",
    "http://%00/",
  ])("refuses %j as malformed", (input) => {
    expect(refusal(input)).toBe("malformed");
  });

  it("holds a URL of 2 048 characters and refuses one of 2 049, as given", () => {
    const prefix = "https://example.com/";
    expect(accepted(prefix + "a".repeat(BOOKMARK_URL_MAX_LENGTH - prefix.length)).url).toHaveLength(BOOKMARK_URL_MAX_LENGTH);
    expect(refusal(prefix + "a".repeat(BOOKMARK_URL_MAX_LENGTH - prefix.length + 1))).toBe("too_long");
    expect(refusal(`javascript:${"a".repeat(BOOKMARK_URL_MAX_LENGTH)}`)).toBe("too_long");
  });

  it("counts the length of the value without the whitespace around it", () => {
    const prefix = "https://example.com/";
    expect(accepted(`  ${prefix}${"a".repeat(BOOKMARK_URL_MAX_LENGTH - prefix.length)}\n`).url).toHaveLength(BOOKMARK_URL_MAX_LENGTH);
  });

  it("trims a value with a long run of whitespace inside it in linear time", { timeout: 1_000 }, () => {
    expect(refusal(`https://example.com/a${"\t".repeat(200_000)}a`)).toBe("too_long");
    expect(refusal(`${" ".repeat(200_000)}x`)).toBe("not_http");
  });

  it("refuses a URL that grows past 2 048 characters once it is normalised", () => {
    const prefix = "https://example.com/";
    const input = prefix + "a b".repeat(Math.floor((BOOKMARK_URL_MAX_LENGTH - prefix.length) / 3));
    expect(input.length).toBeLessThanOrEqual(BOOKMARK_URL_MAX_LENGTH);
    expect(refusal(input)).toBe("too_long");
  });

  it("stores no URL whose scheme is not http or https, whatever the value looks like", () => {
    for (const input of ["https://example.com/", "HTTP://example.com", "  http://example.com:80/x?y#z", "https://日本語.jp/"]) {
      expect(accepted(input).url).toMatch(/^https?:\/\//);
      expect(accepted(input).canonical).toMatch(/^https?:\/\//);
    }
  });
});
