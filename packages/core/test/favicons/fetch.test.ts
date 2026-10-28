import { FakeEgress } from "@slugbase/testing-ports";
import { describe, expect, it } from "vitest";
import {
  FAVICON_CONTENT_TYPES,
  FAVICON_LINK_CANDIDATES_MAX,
  FAVICON_MAX_BYTES,
  fetchFavicon,
  ImageRefused,
  PortUnavailable,
  type ImageCodecPort,
  type ReencodedIcon,
} from "../../src/index.ts";

// The fetch of a host's favicon (doc 02 section 5.4, doc 10 T6 and T14): `/favicon.ico` over https and then http, then the `<link rel=icon>` targets of the
// home page, every request through the egress port with the 64 KiB cap and the image content types, every body through the image codec. The failure scenario:
// an SVG with a script, a body over 64 KiB, an HTML page served as the icon, a redirect to a private address and an image the codec refuses all end with no
// icon, and nothing of a refused body is ever handed on.

const ENCODER = new TextEncoder();
const ICON_BYTES = ENCODER.encode("an-icon");
const OUT: ReencodedIcon = { png64: ENCODER.encode("png-64"), png32: ENCODER.encode("png-32") };

/** A codec that accepts the bytes of `ICON_BYTES` and refuses everything else as the real one refuses an unsupported format. */
function codec(): ImageCodecPort & { readonly seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  return {
    available: true,
    seen,
    reencodeIcon: (input) => {
      seen.push(input);
      return Buffer.from(input).equals(Buffer.from(ICON_BYTES)) ? Promise.resolve(OUT) : Promise.reject(new ImageRefused("unsupported_format"));
    },
  };
}

const ico = (body: Uint8Array = ICON_BYTES): { contentType: string; body: Uint8Array } => ({ contentType: "image/x-icon", body });
const html = (links: string): { contentType: string; body: Uint8Array } => ({
  contentType: "text/html; charset=utf-8",
  body: ENCODER.encode(`<html><head><title>T</title>${links}</head><body></body></html>`),
});

describe("the favicon of a host", () => {
  it("is /favicon.ico over https, converted by the codec, when the host serves one", async () => {
    const egress = new FakeEgress({ "https://example.test/favicon.ico": ico() });
    const images = codec();

    expect(await fetchFavicon({ egress, imageCodec: images }, "example.test")).toEqual({ kind: "ok", ...OUT });

    expect(egress.fetched).toEqual(["https://example.test/favicon.ico"]);
    expect(egress.requests[0]).toMatchObject({ maxBytes: FAVICON_MAX_BYTES, acceptContentTypes: FAVICON_CONTENT_TYPES });
    expect(images.seen).toHaveLength(1);
  });

  it("only accepts image content types, and svg is not among them", () => {
    expect(FAVICON_CONTENT_TYPES.every((type) => type.startsWith("image/"))).toBe(true);
    expect(FAVICON_CONTENT_TYPES).not.toContain("image/svg+xml");
    expect(FAVICON_MAX_BYTES).toBe(65_536);
  });

  it("falls back to http for /favicon.ico when https gives nothing", async () => {
    const egress = new FakeEgress({ "https://example.test/favicon.ico": { status: 404, contentType: "text/html" }, "http://example.test/favicon.ico": ico() });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toMatchObject({ kind: "ok" });

    expect(egress.fetched).toEqual(["https://example.test/favicon.ico", "http://example.test/favicon.ico"]);
  });

  it("reads the link rel=icon targets of the home page after /favicon.ico, relative ones against the page", async () => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "http://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "https://example.test/": html('<link rel="shortcut icon" href="/assets/icon.png"><link rel="stylesheet" href="/x.css">'),
      "https://example.test/assets/icon.png": { contentType: "image/png", body: ICON_BYTES },
    });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toMatchObject({ kind: "ok" });

    expect(egress.fetched.slice(-2)).toEqual(["https://example.test/", "https://example.test/assets/icon.png"]);
  });

  it("asks the home page over http when https has none, and follows an icon on another host through the port", async () => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "http://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "https://example.test/": { status: 503, contentType: "text/html" },
      "http://example.test/": html('<link rel="icon" href="https://cdn.example.net/i.png">'),
      "https://cdn.example.net/i.png": { contentType: "image/png", body: ICON_BYTES },
    });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toMatchObject({ kind: "ok" });
  });

  it("tries no more than four link candidates, in document order, and ignores a link that is not an http or https address", async () => {
    const links = [
      '<link rel="icon" href="data:image/png;base64,AAAA">',
      '<link rel="icon" href="javascript:alert(1)">',
      ...Array.from({ length: 6 }, (_, index) => `<link rel="icon" href="/bad${String(index)}.png">`),
    ].join("");
    const routes: Record<string, { status: number; contentType: string }> = {};
    for (let index = 0; index < 6; index += 1) {
      routes[`https://example.test/bad${String(index)}.png`] = { status: 404, contentType: "image/png" };
    }
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "http://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "https://example.test/": html(links),
      ...routes,
    });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toEqual({ kind: "none" });

    expect(FAVICON_LINK_CANDIDATES_MAX).toBe(4);
    expect(egress.fetched.filter((url) => url.includes("/bad"))).toEqual([0, 1, 2, 3].map((index) => `https://example.test/bad${String(index)}.png`));
  });

  it("is none for a host with no icon anywhere", async () => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": { status: 404, contentType: "text/html" },
      "http://example.test/favicon.ico": { status: 404, contentType: "text/html" },
      "https://example.test/": html(""),
    });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toEqual({ kind: "none" });
  });
});

describe("a candidate that is not a usable icon", () => {
  const hostile: [string, { contentType: string; body: Uint8Array; status?: number }][] = [
    ["an SVG with a script, served as an SVG", { contentType: "image/svg+xml", body: ENCODER.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }],
    ["an SVG with a script, served as a PNG", { contentType: "image/png", body: ENCODER.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }],
    ["an HTML page served as the icon", { contentType: "text/html", body: ENCODER.encode("<html><script>alert(1)</script></html>") }],
    ["an HTML page served with an image type", { contentType: "image/x-icon", body: ENCODER.encode("<html><script>alert(1)</script></html>") }],
    ["a body over 64 KiB", { contentType: "image/png", body: new Uint8Array(FAVICON_MAX_BYTES + 1) }],
    ["an empty body", { contentType: "image/png", body: new Uint8Array() }],
    ["an error page", { status: 500, contentType: "image/png", body: ICON_BYTES }],
  ];

  it.each(hostile)("ends with no icon: %s", async (_name, response) => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": response,
      "http://example.test/favicon.ico": response,
      "https://example.test/": html(""),
    });
    const images = codec();

    expect(await fetchFavicon({ egress, imageCodec: images }, "example.test")).toEqual({ kind: "none" });

    // Whatever the port let through is judged by the codec alone; what the port refused never reaches it.
    for (const seen of images.seen) {
      expect(Buffer.from(seen).equals(Buffer.from(ICON_BYTES))).toBe(false);
    }
  });

  it("ends with no icon when the target is refused, also behind a redirect to a private address", async () => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" },
      "http://example.test/favicon.ico": { kind: "blocked" },
      "https://example.test/": html('<link rel="icon" href="http://10.0.0.1/icon.png">'),
    });
    const images = codec();

    expect(await fetchFavicon({ egress, imageCodec: images }, "example.test")).toEqual({ kind: "none" });

    expect(images.seen).toEqual([]);
    expect(egress.fetched.some((url) => url.includes("169.254.169.254") || url.includes("10.0.0.1"))).toBe(false);
  });

  it("goes on to the next candidate after one the codec refuses", async () => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": ico(ENCODER.encode("not-an-image")),
      "http://example.test/favicon.ico": { status: 404, contentType: "image/png" },
      "https://example.test/": html('<link rel="icon" href="/real.png">'),
      "https://example.test/real.png": { contentType: "image/png", body: ICON_BYTES },
    });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toMatchObject({ kind: "ok" });
  });

  it("ends a timeout as no icon", async () => {
    const egress = new FakeEgress({
      "https://example.test/favicon.ico": { kind: "timeout" },
      "http://example.test/favicon.ico": { kind: "timeout" },
      "https://example.test/": { kind: "timeout" },
      "http://example.test/": { kind: "timeout" },
    });

    expect(await fetchFavicon({ egress, imageCodec: codec() }, "example.test")).toEqual({ kind: "none" });
  });
});

describe("a port that cannot answer", () => {
  it("rejects when the egress port is not configured, instead of recording a host without an icon", async () => {
    const egress = { available: false, request: () => Promise.reject(new PortUnavailable("egress", "unavailable")) };

    await expect(fetchFavicon({ egress, imageCodec: codec() }, "example.test")).rejects.toBeInstanceOf(PortUnavailable);
  });

  it("rejects when the codec fails for a reason that is not a refusal of the image", async () => {
    const egress = new FakeEgress({ "https://example.test/favicon.ico": ico() });
    const imageCodec: ImageCodecPort = { available: true, reencodeIcon: () => Promise.reject(new Error("the codec crashed")) };

    await expect(fetchFavicon({ egress, imageCodec }, "example.test")).rejects.toThrow("the codec crashed");
  });
});
