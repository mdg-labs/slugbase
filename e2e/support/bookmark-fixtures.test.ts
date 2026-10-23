import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOKMARK_SHAPE_NAMES, bookmarkBody, bookmarkShape, demoBookmarks } from "./bookmark-fixtures.ts";

void describe("the bookmark fixtures of the journeys", () => {
  void it("are the demo workspace of the development seed, 300 bookmarks with the named shapes first", () => {
    assert.equal(demoBookmarks.length, 300);
    assert.equal(bookmarkShape("markup-title").title, "<img src=x onerror=alert(1)>");
    assert.deepEqual(
      BOOKMARK_SHAPE_NAMES.map((name) => bookmarkShape(name)),
      demoBookmarks.slice(0, BOOKMARK_SHAPE_NAMES.length),
    );
  });

  void it("turn a shape into the body of a create request, with only the fields the request declares", () => {
    assert.deepEqual(bookmarkBody(bookmarkShape("single-character-title")), { url: "https://example.com/one", title: "x" });
    const pinned = bookmarkBody(bookmarkShape("pinned-opened"));
    assert.deepEqual(Object.keys(pinned).sort(), ["pinned", "title", "url"]);
    assert.equal(pinned.pinned, true);
    assert.equal(bookmarkBody(bookmarkShape("markup-description")).description?.includes("<script>"), true);
  });
});
