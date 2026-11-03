import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparableExport, decodeEntities, isWebAddress, linksOfBookmarkFile } from "./round-trip.ts";

// The comparison of the import-and-export journey has to fail where the product loses something: a field the import dropped, a list in another
// order, a value that changed. These tests hold that, and that only the two fields that are meant to differ are ignored.

const document = (changes: Record<string, unknown> = {}, workspace = "Main", exportedAt = "2026-11-03T10:00:00.000Z"): string =>
  JSON.stringify({
    format: "slugbase-export",
    version: 1,
    exportedAt,
    workspace: { name: workspace },
    folders: [{ name: "Work", icon: "rocket", color: 5 }],
    tags: ["a", "b"],
    bookmarks: [
      { ref: "b1", url: "https://example.com/1", title: "One", description: null, slug: "one", forwarding: true, pinned: true, planArchived: false, folders: ["Work"], tags: ["a"] },
      { ref: "b2", url: "https://example.com/2", title: "Two", description: "text", slug: null, forwarding: false, pinned: false, planArchived: false, folders: [], tags: [] },
    ],
    goPreferences: [{ slug: "one", bookmarkRef: "b1" }],
    shared: [],
    ...changes,
  });

void describe("the comparison of two exports", () => {
  void it("ignores the time of the export and the name of the workspace, and nothing else", () => {
    assert.equal(comparableExport(document({}, "Main", "2026-11-03T10:00:00.000Z")), comparableExport(document({}, "A fresh workspace", "2026-11-04T08:30:00.000Z")));
  });

  void it("tells apart a field that went missing, a changed value and a folder with another icon or colour", () => {
    const original = comparableExport(document());
    const first = {
      ref: "b1",
      url: "https://example.com/1",
      title: "One",
      description: null,
      slug: "one",
      forwarding: true,
      pinned: true,
      planArchived: false,
      folders: ["Work"],
      tags: ["a"],
    };
    const second = { ref: "b2", url: "https://example.com/2", title: "Two", description: "text", slug: null, forwarding: false, pinned: false, planArchived: false, folders: [], tags: [] };
    const withoutPinned = { ref: "b1", url: "https://example.com/1", title: "One", description: null, slug: "one", forwarding: true, planArchived: false, folders: ["Work"], tags: ["a"] };
    for (const changed of [
      { bookmarks: [withoutPinned, second] },
      { bookmarks: [{ ...first, pinned: false }, second] },
      { bookmarks: [{ ...first, forwarding: false }, second] },
      { bookmarks: [first, { ...second, description: null }] },
      { folders: [{ name: "Work", icon: "folder", color: 5 }] },
      { folders: [{ name: "Work", icon: "rocket", color: 1 }] },
      { tags: ["a"] },
      { goPreferences: [] },
    ]) {
      assert.notEqual(comparableExport(document(changed)), original, JSON.stringify(changed).slice(0, 80));
    }
  });

  void it("tells apart the same bookmarks in another order", () => {
    const parsed = JSON.parse(document()) as { bookmarks: unknown[] };
    assert.notEqual(comparableExport(document({ bookmarks: [...parsed.bookmarks].reverse() })), comparableExport(document()));
  });

  void it("refuses text that is not an export document", () => {
    assert.throws(() => comparableExport("[]"), /not a JSON object/);
    assert.throws(() => comparableExport('{"format":"other"}'), /not a SlugBase export/);
    assert.throws(() => comparableExport('{"format":"slugbase-export"}'), /names no workspace/);
  });
});

void describe("the links of a browser bookmark file", () => {
  void it("reads the address and the title of each link, whatever the case of the tags and the order of the attributes", () => {
    const html = [
      '<DT><A HREF="https://example.com/chrome/two?a=1&amp;b=2" ADD_DATE="1">Chrome &amp; Two</A>',
      '<dt><a add_date="2" href="https://example.com/three"></a>',
      "<DT><A HREF=\"javascript:void(window.open('https://example.com/'))\">A bookmarklet</A>",
      '<DT><A SHORTCUTURL="x" HREF="https://example.com/&#228;&#x44;" TAGS="a,b">&lt;b&gt; &quot;t&quot;</A>',
    ].join("\n");
    assert.deepEqual(linksOfBookmarkFile(html), [
      { url: "https://example.com/chrome/two?a=1&b=2", title: "Chrome & Two" },
      { url: "https://example.com/three", title: "" },
      { url: "javascript:void(window.open('https://example.com/'))", title: "A bookmarklet" },
      { url: "https://example.com/äD", title: '<b> "t"' },
    ]);
  });

  void it("decodes the references and leaves an unknown one as it is", () => {
    assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#65;&#x42; &unknown; &"), "a & b <c> AB &unknown; &");
  });

  void it("calls an address a web address when it is http or https", () => {
    assert.equal(isWebAddress("https://example.com/"), true);
    assert.equal(isWebAddress("HTTP://example.com/"), true);
    for (const other of ["edge://settings/", "place:parent=1", "javascript:void(0)", "ftp://example.com/"]) {
      assert.equal(isWebAddress(other), false, other);
    }
  });
});
