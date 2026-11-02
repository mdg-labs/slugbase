import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { IMPORT_MAX_BOOKMARKS, IMPORT_MAX_BYTES, ImportQuerySchema, ImportRequestSchema, ImportResultSchema, importJson, operations } from "../src/index.ts";

// The import preview of doc 04 section 10.9 and doc 02 section 13.1: POST /api/v1/import/json is a member's write in the bulk bucket that accepts an Idempotency-Key and a body of up to 5 MiB. Its
// request is the export document or a plain array of bookmarks in strict schemas; a bad bookmark is not the request's failure, a file that is not the format is.

type Obj = Record<string, unknown>;
const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as { paths: Record<string, Record<string, Obj>>; components: { schemas: Record<string, Obj> } };
const documented = document.paths["/api/v1/import/json"]?.["post"] as Obj;

const ENVELOPE = { format: "slugbase-export", version: 1, bookmarks: [{ url: "https://example.com/a" }] };

describe("the import operation", () => {
  it("is POST /api/v1/import/json, a member's write in the bulk bucket with an idempotency key and a body limit of 5 MiB", () => {
    expect(importJson).toMatchObject({ method: "post", path: "/api/v1/import/json", operationId: "importJson", tag: "import", auth: "member", rate: "bulk", scope: "write", idempotency: true, maxBodyBytes: 5 * 1024 * 1024 });
    expect(IMPORT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(IMPORT_MAX_BOOKMARKS).toBe(5000);
    expect(operations).toContain(importJson);
    expect(documented).toMatchObject({ operationId: "importJson", "x-slugbase-auth": "member", "x-slugbase-rate": "bulk", "x-slugbase-scope": "write", "x-slugbase-idempotency": true });
  });

  it("documents the answers of a preview, the 413 and the 422 included, and the query that makes it one", () => {
    expect(Object.keys(documented["responses"] as Obj).sort()).toEqual(["200", "400", "401", "403", "404", "409", "413", "422", "429", "503"]);
    const parameters = documented["parameters"] as { name: string; in: string; required: boolean }[];
    expect(parameters.filter((parameter) => parameter.in === "query").map((parameter) => [parameter.name, parameter.required])).toEqual([
      ["dryRun", false],
      ["skipDuplicates", false],
    ]);
  });

  it("publishes the file as the document or an array of closed bookmark objects, with no field that accepts anything", () => {
    for (const name of ["ImportEnvelope", "ImportBookmark", "ImportFolder", "ImportResult", "ImportSkipped", "ImportFailed", "ImportDroppedSlug"]) {
      expect(document.components.schemas[name]?.["additionalProperties"], name).toBe(false);
    }
    expect(JSON.stringify(document.components.schemas["ImportEnvelope"])).not.toContain('"items":{}');
    expect(((documented["requestBody"] as Obj)["content"] as Obj)["application/json"]).toMatchObject({ schema: { anyOf: [{ $ref: "#/components/schemas/ImportEnvelope" }, { type: "array", maxItems: 5000 }] } });
  });
});

describe("the import request", () => {
  it("is the export document of the format, or a plain array of bookmarks", () => {
    expect(ImportRequestSchema.safeParse(ENVELOPE).success).toBe(true);
    expect(ImportRequestSchema.safeParse([{ url: "https://example.com/a" }]).success).toBe(true);
    expect(ImportRequestSchema.safeParse([]).success).toBe(true);
    expect(
      ImportRequestSchema.safeParse({
        format: "slugbase-export",
        version: 1,
        exportedAt: "2026-11-02T10:00:00.000Z",
        workspace: { name: "Home" },
        folders: [{ name: "Reading", icon: "folder", color: 1 }],
        tags: ["news"],
        bookmarks: [{ ref: "b1", url: "https://example.com/a", title: "A", description: null, slug: "a", forwarding: true, pinned: false, planArchived: false, folders: ["Reading"], tags: ["news"] }],
        goPreferences: [],
        shared: [],
      }).success,
    ).toBe(true);
  });

  it("refuses what is not the format as a whole: another format, a field it does not declare, a value of the wrong type", () => {
    for (const body of [
      { ...ENVELOPE, format: "other" },
      { ...ENVELOPE, extra: 1 },
      { ...ENVELOPE, bookmarks: [{ url: "https://example.com/a", extra: 1 }] },
      [{ url: 1 }],
      [{ title: "no url" }],
      [{ url: "https://example.com/a", folders: "Reading" }],
      [{ url: "https://example.com/a", pinned: "yes" }],
      [{ url: "https://example.com/a", constructor: {} }],
      { ...ENVELOPE, shared: [{ x: 1 }] },
      "text",
      null,
      [[]],
    ]) {
      expect(ImportRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("refuses more than 5 000 bookmarks and takes 5 000", () => {
    const items = (count: number) => Array.from({ length: count }, (_, index) => ({ url: `https://example.com/${String(index)}` }));
    expect(ImportRequestSchema.safeParse(items(IMPORT_MAX_BOOKMARKS)).success).toBe(true);
    expect(ImportRequestSchema.safeParse(items(IMPORT_MAX_BOOKMARKS + 1)).success).toBe(false);
    expect(ImportRequestSchema.safeParse({ ...ENVELOPE, bookmarks: items(IMPORT_MAX_BOOKMARKS + 1) }).success).toBe(false);
  });

  it("leaves a bad URL and an over-long text to the bookmark and not to the file", () => {
    expect(ImportRequestSchema.safeParse([{ url: "javascript:alert(1)", title: "t".repeat(10_000), description: "d".repeat(10_000), slug: "S L U G", folders: ["f".repeat(500)], tags: ["t".repeat(500)] }]).success).toBe(true);
  });

  it("refuses a version newer than the format with an error at version, also when the file holds fields this version does not know", () => {
    for (const body of [{ ...ENVELOPE, version: 2 }, { ...ENVELOPE, version: 2, groups: [], bookmarks: [{ url: "https://example.com/a", visits: 3 }] }]) {
      const result = ImportRequestSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("version");
    }
    expect(ImportRequestSchema.safeParse({ ...ENVELOPE, version: 0 }).success).toBe(false);
    expect(ImportRequestSchema.safeParse({ ...ENVELOPE, version: 1.5 }).success).toBe(false);
  });
});

describe("the import query", () => {
  it("takes dryRun only as true, which the handler then needs, and skipDuplicates as true or false", () => {
    expect(ImportQuerySchema.safeParse({}).success).toBe(true);
    expect(ImportQuerySchema.safeParse({ dryRun: "true" }).success).toBe(true);
    expect(ImportQuerySchema.safeParse({ dryRun: "true", skipDuplicates: "false" }).success).toBe(true);
    for (const query of [{ dryRun: "false" }, { dryRun: "1" }, { dryRun: "true", skipDuplicates: "maybe" }, { dryRun: "true", other: "1" }]) {
      expect(ImportQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });
});

describe("the import result", () => {
  const RESULT = {
    detected: { bookmarks: 3, folders: 1, tags: 2 },
    created: 1,
    skipped: [{ position: 2, title: "B", url: "https://example.com/b", reason: "duplicate" }],
    failed: [{ position: 3, title: "", url: "javascript:alert(1)", reason: "url_not_allowed" }],
    slugsDropped: 0,
    droppedSlugs: [],
    foldersCreated: 0,
    tagsCreated: 0,
  };

  it("is the counts of the file, the creations, the skipped and failed entries and the counts of slugs, folders and tags", () => {
    expect(ImportResultSchema.parse(RESULT)).toEqual(RESULT);
    expect(Object.keys(ImportResultSchema.shape)).toEqual(["detected", "created", "skipped", "failed", "slugsDropped", "droppedSlugs", "foldersCreated", "tagsCreated"]);
  });

  it("names the reasons it reports, and cuts a title and a URL to their limits", () => {
    expect(ImportResultSchema.safeParse({ ...RESULT, skipped: [{ ...RESULT.skipped[0], reason: "bookmark_limit_reached" }] }).success).toBe(true);
    expect(ImportResultSchema.safeParse({ ...RESULT, failed: [{ ...RESULT.failed[0], reason: "url_invalid" }] }).success).toBe(true);
    expect(ImportResultSchema.safeParse({ ...RESULT, skipped: [{ ...RESULT.skipped[0], reason: "other" }] }).success).toBe(false);
    expect(ImportResultSchema.safeParse({ ...RESULT, failed: [{ ...RESULT.failed[0], reason: "duplicate" }] }).success).toBe(false);
    expect(ImportResultSchema.safeParse({ ...RESULT, skipped: [{ ...RESULT.skipped[0], title: "t".repeat(301) }] }).success).toBe(false);
    expect(ImportResultSchema.safeParse({ ...RESULT, failed: [{ ...RESULT.failed[0], url: "u".repeat(2049) }] }).success).toBe(false);
  });
});
