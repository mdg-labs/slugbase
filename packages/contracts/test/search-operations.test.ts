import { describe, expect, it } from "vitest";
import { SearchQuerySchema, SearchResultsSchema, operations, search } from "../src/index.ts";

// The search of doc 04 section 10.8 and doc 02 section 9.1: GET /api/v1/search takes the read scope of a token and the `read` rate bucket, as a member in the active workspace.

const UUID = "0192f3a0-aaaa-7000-8000-00000000a0b1";
const BOOKMARK = { id: UUID, title: "Mail", url: "https://mail.example.com/", host: "mail.example.com", slug: "mail", forwarding: true, pinned: false };

describe("the search operation", () => {
  it("is GET /api/v1/search, a member's read in the read rate bucket", () => {
    expect(search).toMatchObject({ method: "get", path: "/api/v1/search", operationId: "search", tag: "search", auth: "member", rate: "read", scope: "read" });
    expect(operations).toEqual(expect.arrayContaining([search]));
  });

  it("declares the answers a client has to handle", () => {
    expect(Object.keys(search.responses).map(Number)).toEqual(expect.arrayContaining([200, 401, 404, 422, 429, 503]));
  });
});

describe("the query", () => {
  it("takes a text, the types and a limit, and nothing else", () => {
    expect(SearchQuerySchema.parse({ q: "mail" })).toEqual({ q: "mail" });
    expect(SearchQuerySchema.parse({ q: "  mail  ", types: "bookmark,tag", limit: "20" })).toEqual({ q: "mail", types: "bookmark,tag", limit: 20 });
    expect(SearchQuerySchema.safeParse({ q: "mail", sort: "name" }).success).toBe(false);
  });

  it("refuses a missing, blank or over-long text", () => {
    expect(SearchQuerySchema.safeParse({}).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "a".repeat(100) }).success).toBe(true);
    expect(SearchQuerySchema.safeParse({ q: "a".repeat(101) }).success).toBe(false);
  });

  it("takes query syntax as text", () => {
    for (const q of ["a & b", "a | !b", "foo:*", "100%", "a_b", String.raw`a\b`, "it's", '"unbalanced', "((", "<->"]) {
      expect(SearchQuerySchema.safeParse({ q }).success, q).toBe(true);
    }
  });

  it("takes a comma-separated list of the three types, and a limit of 1 to 20", () => {
    for (const types of ["bookmark", "folder", "tag", "bookmark,folder,tag", "tag,bookmark"]) {
      expect(SearchQuerySchema.safeParse({ q: "x", types }).success, types).toBe(true);
    }
    for (const types of ["", "bookmarks", "bookmark,", ",tag", "bookmark, tag", "team", "bookmark,team"]) {
      expect(SearchQuerySchema.safeParse({ q: "x", types }).success, types).toBe(false);
    }
    expect(SearchQuerySchema.safeParse({ q: "x", limit: "1" }).success).toBe(true);
    expect(SearchQuerySchema.safeParse({ q: "x", limit: "0" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "x", limit: "21" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "x", limit: "1.5" }).success).toBe(false);
  });
});

describe("the results", () => {
  it("are three lists, each of the fields the palette shows", () => {
    expect(SearchResultsSchema.safeParse({ bookmarks: [BOOKMARK], folders: [{ id: UUID, name: "Work", icon: "folder", color: 3 }], tags: [{ id: UUID, name: "read" }] }).success).toBe(true);
    expect(SearchResultsSchema.safeParse({ bookmarks: [], folders: [], tags: [] }).success).toBe(true);
    expect(SearchResultsSchema.safeParse({ bookmarks: [], folders: [] }).success).toBe(false);
    expect(SearchResultsSchema.safeParse({ bookmarks: [{ ...BOOKMARK, ownerId: UUID }], folders: [], tags: [] }).success).toBe(false);
    expect(SearchResultsSchema.safeParse({ bookmarks: [{ ...BOOKMARK, slug: null }], folders: [], tags: [] }).success).toBe(true);
  });
});
