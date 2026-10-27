import { describe, expect, it } from "vitest";
import {
  GoChooseRequestSchema,
  GoResolutionSchema,
  GoSlugRequestSchema,
  GoSuggestQuerySchema,
  GoSuggestionsSchema,
  chooseSlug,
  operations,
  resolveSlug,
  suggestSlugs,
} from "../src/index.ts";

// The go operations of doc 04 section 10.8: how a slug resolves for a member and how a member picks one of its candidates. Both are in the go rate
// bucket and take the write scope of a token (a POST, though the resolution writes nothing).

const UUID = "0192f3a0-aaaa-7000-8000-00000000a0b1";
const CANDIDATE = { id: UUID, title: "Mail", host: "mail.example.com", owner: null, sharedVia: null };

describe("the go operations", () => {
  it("are POST /api/v1/go/resolve and /go/choose, members' operations of the go bucket", () => {
    expect(resolveSlug).toMatchObject({ method: "post", path: "/api/v1/go/resolve", operationId: "resolveSlug", tag: "go", auth: "member", rate: "go", scope: "write" });
    expect(chooseSlug).toMatchObject({ method: "post", path: "/api/v1/go/choose", operationId: "chooseSlug", tag: "go", auth: "member", rate: "go", scope: "write" });
    expect(operations).toEqual(expect.arrayContaining([resolveSlug, chooseSlug]));
  });

  it("declare the answers a client has to handle", () => {
    expect(Object.keys(resolveSlug.responses).map(Number)).toEqual(expect.arrayContaining([200, 400, 401, 403, 404, 422, 429, 503]));
    expect(Object.keys(chooseSlug.responses).map(Number)).toEqual(expect.arrayContaining([200, 400, 401, 403, 404, 422, 429, 503]));
  });
});

describe("the request bodies", () => {
  it("take a slug of any text, which the server judges, and nothing else", () => {
    expect(GoSlugRequestSchema.safeParse({ slug: "mail" }).success).toBe(true);
    expect(GoSlugRequestSchema.safeParse({ slug: "Not a slug / at all" }).success).toBe(true);
    expect(GoSlugRequestSchema.safeParse({}).success).toBe(false);
    expect(GoSlugRequestSchema.safeParse({ slug: null }).success).toBe(false);
    expect(GoSlugRequestSchema.safeParse({ slug: "mail", extra: true }).success).toBe(false);
  });

  it("take a slug, the identifier of a bookmark and whether to remember, which may be left out", () => {
    expect(GoChooseRequestSchema.safeParse({ slug: "mail", bookmarkId: UUID, remember: true }).success).toBe(true);
    expect(GoChooseRequestSchema.safeParse({ slug: "mail", bookmarkId: UUID }).success).toBe(true);
    expect(GoChooseRequestSchema.safeParse({ slug: "mail", bookmarkId: "mail" }).success).toBe(false);
    expect(GoChooseRequestSchema.safeParse({ slug: "mail", bookmarkId: UUID, remember: "yes" }).success).toBe(false);
    expect(GoChooseRequestSchema.safeParse({ bookmarkId: UUID }).success).toBe(false);
    expect(GoChooseRequestSchema.safeParse({ slug: "mail", bookmarkId: UUID, extra: 1 }).success).toBe(false);
  });
});

describe("the resolution", () => {
  it("is none, preferred, single or multiple, each with exactly its fields", () => {
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: [] }).success).toBe(true);
    expect(GoResolutionSchema.safeParse({ result: "preferred", bookmark: CANDIDATE }).success).toBe(true);
    expect(GoResolutionSchema.safeParse({ result: "single", bookmark: CANDIDATE }).success).toBe(true);
    expect(GoResolutionSchema.safeParse({ result: "multiple", candidates: [CANDIDATE, { ...CANDIDATE, id: UUID.replace("b1", "b2"), owner: { accountId: UUID, displayName: "Ann" }, sharedVia: "team" }] }).success).toBe(true);
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: [], bookmark: CANDIDATE }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "single" }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "multiple", candidates: [CANDIDATE] }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "other" }).success).toBe(false);
  });

  it("names the other workspaces of a none by identifier and name, at most twenty, and nothing else of them", () => {
    const workspace = { id: UUID, name: "Work" };
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: [workspace] }).success).toBe(true);
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: Array.from({ length: 20 }, () => workspace) }).success).toBe(true);
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: Array.from({ length: 21 }, () => workspace) }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "none" }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: [{ ...workspace, role: "owner" }] }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "none", otherWorkspaces: [{ id: "work", name: "Work" }] }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "single", bookmark: CANDIDATE, otherWorkspaces: [workspace] }).success).toBe(false);
  });

  it("names a bookmark by identifier, title, host, owner and how it is shared, and never an address", () => {
    expect(GoResolutionSchema.safeParse({ result: "single", bookmark: { ...CANDIDATE, url: "https://mail.example.com/" } }).success).toBe(false);
    expect(GoResolutionSchema.safeParse({ result: "single", bookmark: { ...CANDIDATE, sharedVia: "link" } }).success).toBe(false);
  });
});

describe("the suggestions", () => {
  const SUGGESTION = { slug: "mail", bookmarkId: UUID, title: "Mail", host: "mail.example.com", owner: null, sharedVia: null };

  it("are GET /api/v1/go/suggest, a member's operation of the go bucket that a token may read", () => {
    expect(suggestSlugs).toMatchObject({ method: "get", path: "/api/v1/go/suggest", operationId: "suggestSlugs", tag: "go", auth: "member", rate: "go", scope: "read" });
    expect(operations).toContain(suggestSlugs);
    expect(Object.keys(suggestSlugs.responses).map(Number)).toEqual(expect.arrayContaining([200, 401, 404, 422, 429, 503]));
  });

  it("take a prefix of any text, which the server judges, an empty one included, and nothing else", () => {
    expect(GoSuggestQuerySchema.safeParse({ prefix: "ma" }).success).toBe(true);
    expect(GoSuggestQuerySchema.safeParse({ prefix: "" }).success).toBe(true);
    expect(GoSuggestQuerySchema.safeParse({ prefix: "100%_\\" }).success).toBe(true);
    expect(GoSuggestQuerySchema.safeParse({}).success).toBe(false);
    expect(GoSuggestQuerySchema.safeParse({ prefix: "a".repeat(101) }).success).toBe(false);
    expect(GoSuggestQuerySchema.safeParse({ prefix: "ma", limit: 5 }).success).toBe(false);
  });

  it("answer at most ten suggestions, each with exactly its fields and never an address", () => {
    expect(GoSuggestionsSchema.safeParse({ suggestions: [] }).success).toBe(true);
    expect(GoSuggestionsSchema.safeParse({ suggestions: Array.from({ length: 10 }, () => SUGGESTION) }).success).toBe(true);
    expect(GoSuggestionsSchema.safeParse({ suggestions: Array.from({ length: 11 }, () => SUGGESTION) }).success).toBe(false);
    expect(GoSuggestionsSchema.safeParse({ suggestions: [{ ...SUGGESTION, owner: { accountId: UUID, displayName: "Ann" }, sharedVia: "team" }] }).success).toBe(true);
    expect(GoSuggestionsSchema.safeParse({ suggestions: [{ ...SUGGESTION, url: "https://mail.example.com/" }] }).success).toBe(false);
    expect(GoSuggestionsSchema.safeParse({ suggestions: [{ ...SUGGESTION, sharedVia: "link" }] }).success).toBe(false);
    expect(GoSuggestionsSchema.safeParse({ suggestions: [{ slug: "mail" }] }).success).toBe(false);
    expect(GoSuggestionsSchema.safeParse([SUGGESTION]).success).toBe(false);
  });
});
