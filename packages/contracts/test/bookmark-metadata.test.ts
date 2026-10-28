import { describe, expect, it } from "vitest";
import { BookmarkMetadataRequestSchema, BookmarkMetadataSchema, BOOKMARK_URL_MAX_LENGTH, fetchBookmarkMetadata, operations } from "../src/index.ts";

// The page-metadata operation in the contract (doc 04 sections 3.2, 7 and 10.6, doc 02 sections 5.4 and 16): a POST of a member in the `fetch` bucket that
// needs the `write` token scope because it writes the cache, with the two refusals of a fetch declared.

describe("the metadata operation", () => {
  it("is a POST of a member at /api/v1/bookmarks/metadata, in the fetch bucket, needing the write scope", () => {
    expect(fetchBookmarkMetadata).toMatchObject({
      method: "post",
      path: "/api/v1/bookmarks/metadata",
      operationId: "fetchBookmarkMetadata",
      auth: "member",
      rate: "fetch",
      scope: "write",
    });
    expect(operations).toContain(fetchBookmarkMetadata);
  });

  it("declares url_not_allowed as a 422 and upstream_failed as a 502, beside the answer", () => {
    expect(Object.keys(fetchBookmarkMetadata.responses).sort()).toEqual(["200", "400", "401", "403", "404", "422", "429", "502", "503"]);
    expect(fetchBookmarkMetadata.responses[422].description).toContain("url_not_allowed");
    expect(fetchBookmarkMetadata.responses[502].description).toContain("upstream_failed");
  });

  it("takes a URL of 1 to 2 048 characters and nothing else", () => {
    expect(BookmarkMetadataRequestSchema.safeParse({ url: "https://example.com/" }).success).toBe(true);
    expect(BookmarkMetadataRequestSchema.safeParse({ url: "a".repeat(BOOKMARK_URL_MAX_LENGTH) }).success).toBe(true);
    expect(BookmarkMetadataRequestSchema.safeParse({ url: "a".repeat(BOOKMARK_URL_MAX_LENGTH + 1) }).success).toBe(false);
    expect(BookmarkMetadataRequestSchema.safeParse({ url: "" }).success).toBe(false);
    expect(BookmarkMetadataRequestSchema.safeParse({}).success).toBe(false);
    expect(BookmarkMetadataRequestSchema.safeParse({ url: 3 }).success).toBe(false);
    expect(BookmarkMetadataRequestSchema.safeParse({ url: "https://example.com/", extra: 1 }).success).toBe(false);
  });

  it("answers the five fields, each a string or null, and whether the answer was cached", () => {
    const answer = { title: "Docs", description: null, siteName: null, canonicalUrl: "https://example.com/docs", language: "en", cached: false };
    expect(BookmarkMetadataSchema.safeParse(answer).success).toBe(true);
    expect(BookmarkMetadataSchema.safeParse({ ...answer, cached: undefined }).success).toBe(false);
    expect(BookmarkMetadataSchema.safeParse({ ...answer, title: undefined }).success).toBe(false);
    expect(BookmarkMetadataSchema.safeParse({ ...answer, language: 3 }).success).toBe(false);
    expect(BookmarkMetadataSchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });
});
