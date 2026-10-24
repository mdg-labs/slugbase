import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { message } from "./catalog.ts";

void describe("the catalog text of the journeys", () => {
  void it("takes the form of a plural that the count selects, around the text that is the same for both", () => {
    assert.equal(message("en", "bookmarks.bulk.delete.title", { count: "1" }), "Delete 1 bookmark?");
    assert.equal(message("en", "bookmarks.bulk.delete.title", { count: "3" }), "Delete 3 bookmarks?");
    assert.equal(message("en", "bookmarks.bulk.count", { count: "2" }), "2 selected");
  });

  void it("refuses a plural without a count and a placeholder without a value", () => {
    assert.throws(() => message("en", "bookmarks.bulk.delete.title"), /\{count\}/);
    assert.throws(() => message("en", "bookmarks.list.select"), /\{title\}/);
  });

  void it("still fills a plain placeholder", () => {
    assert.equal(message("en", "bookmarks.list.select", { title: "A" }), "Select A");
  });
});
