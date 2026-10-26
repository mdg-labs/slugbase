import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { message } from "./catalog.ts";

void describe("the catalog text of the journeys", () => {
  void it("takes the form of a plural that the count selects, around the text that is the same for both", () => {
    assert.equal(message("en", "bookmarks.bulk.delete.title", { count: "1" }), "Delete 1 bookmark?");
    assert.equal(message("en", "bookmarks.bulk.delete.title", { count: "3" }), "Delete 3 bookmarks?");
    assert.equal(message("en", "bookmarks.bulk.count", { count: "2" }), "2 selected");
  });

  void it("takes an arm for one count, and fills the placeholders that an arm holds", () => {
    assert.equal(message("en", "folders.delete.description", { count: "0" }), "No bookmarks are in this folder; only the folder goes.");
    assert.equal(message("en", "folders.delete.description", { count: "1" }), "The 1 bookmark stays; only the folder goes.");
    assert.equal(message("en", "folders.delete.description", { count: "2" }), "The 2 bookmarks stay; only the folder goes.");
    assert.equal(
      message("en", "tags.merge.description", { count: "2", from: "a", into: "b" }),
      "You already have a tag named \u201cb\u201d. The 2 bookmarks tagged \u201ca\u201d are tagged \u201cb\u201d instead, and \u201ca\u201d is deleted. The bookmarks stay.",
    );
    assert.equal(message("en", "tags.merge.description", { count: "0", from: "a", into: "b" }), "You already have a tag named \u201cb\u201d. \u201ca\u201d is on no bookmark; it is deleted.");
  });

  void it("refuses a plural without a count and a placeholder without a value", () => {
    assert.throws(() => message("en", "bookmarks.bulk.delete.title"), /\{count\}/);
    assert.throws(() => message("en", "bookmarks.list.select"), /\{title\}/);
  });

  void it("still fills a plain placeholder", () => {
    assert.equal(message("en", "bookmarks.list.select", { title: "A" }), "Select A");
  });
});
