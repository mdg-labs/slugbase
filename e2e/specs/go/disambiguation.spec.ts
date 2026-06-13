import { test } from "../../fixtures/auth.js";

test.describe("Go disambiguation", () => {
  // SKIPPED: The database enforces slug uniqueness per workspace (bookmarks_workspace_slug_unique_idx),
  // but the spec (8.2) describes disambiguation for "multiple accessible bookmarks" with the same
  // slug "possible through sharing". The DB constraint prevents this scenario from occurring for
  // bookmarks owned by the same user. These tests need a second user + sharing setup to create a
  // valid disambiguation scenario.
  // See spec 8.2, 11.9 for the expected behavior once the schema supports it.

  test.skip("two bookmarks with same slug shows disambiguation page, user picks candidate", async () => {
    // placeholder
  });

  test.skip("disambiguation with remember preference saves choice", async () => {
    // placeholder
  });
});
