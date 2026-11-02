import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { IMPORT_MAX_BOOKMARKS, IMPORT_MAX_BYTES, IMPORT_NAME_MAX_LENGTH, ImportBookmarkSchema, ImportEnvelopeSchema, ImportQuerySchema, ImportRequestSchema, ImportResultSchema, IMPORT_NETSCAPE_ENVELOPE_BYTES, IMPORT_NETSCAPE_FIELD, IMPORT_NETSCAPE_MAX_FILE_BYTES, importJson, importNetscape, operations } from "../src/index.ts";

// The import preview of doc 04 section 10.9 and doc 02 section 13.1: POST /api/v1/import/json is a member's write in the bulk bucket that accepts an Idempotency-Key and a body of up to 5 MiB. Its
// request is the export document or a plain array of bookmarks in strict schemas; a bad bookmark is not the request's failure, a file that is not the format is.

type Obj = Record<string, unknown>;
const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as { paths: Record<string, Record<string, Obj>>; components: { schemas: Record<string, Obj> } };
const documented = document.paths["/api/v1/import/json"]?.["post"] as Obj;

const ENVELOPE = { format: "slugbase-export", version: 1, bookmarks: [{ url: "https://example.com/a" }] };
const SHARED_ENTRY = { url: "https://example.com/theirs", title: "Theirs", description: null, slug: "theirs", ownerName: "Olga Owner", shared: true };

describe("the import operation", () => {
  it("is POST /api/v1/import/json, a member's write in the bulk bucket with an idempotency key and a body limit of 5 MiB", () => {
    expect(importJson).toMatchObject({ method: "post", path: "/api/v1/import/json", operationId: "importJson", tag: "import", auth: "member", rate: "bulk", scope: "write", idempotency: true, maxBodyBytes: 5 * 1024 * 1024 });
    expect(IMPORT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(IMPORT_MAX_BOOKMARKS).toBe(5000);
    expect(operations).toContain(importJson);
    expect(documented).toMatchObject({ operationId: "importJson", "x-slugbase-auth": "member", "x-slugbase-rate": "bulk", "x-slugbase-scope": "write", "x-slugbase-idempotency": true });
  });

  it("documents the answers of an import, the 413 and the 422 included, and the query that makes it a dry run", () => {
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

describe("the Netscape import operation", () => {
  const entry = document.paths["/api/v1/import/netscape"]?.["post"] as Obj;

  it("is POST /api/v1/import/netscape, a member's operation in the bulk bucket with an idempotency key, no token scope and a body limit of 5 MiB and the envelope of an upload", () => {
    expect(importNetscape).toMatchObject({ method: "post", path: "/api/v1/import/netscape", operationId: "importNetscape", tag: "import", auth: "member", rate: "bulk", idempotency: true });
    expect(importNetscape).not.toHaveProperty("scope");
    expect(importNetscape.maxBodyBytes).toBe(IMPORT_NETSCAPE_MAX_FILE_BYTES + IMPORT_NETSCAPE_ENVELOPE_BYTES);
    expect(IMPORT_NETSCAPE_MAX_FILE_BYTES).toBe(IMPORT_MAX_BYTES);
    expect(operations).toContain(importNetscape);
    expect(entry).toMatchObject({ operationId: "importNetscape", "x-slugbase-auth": "member", "x-slugbase-rate": "bulk", "x-slugbase-idempotency": true });
    expect(entry).not.toHaveProperty("x-slugbase-scope");
  });

  it("declares its body as multipart/form-data with the one file, takes the query of the JSON import and answers its result", () => {
    expect(IMPORT_NETSCAPE_FIELD).toBe("file");
    expect(importNetscape.request).toMatchObject({ query: ImportQuerySchema, upload: { field: "file" } });
    expect(importNetscape.request).not.toHaveProperty("body");
    expect((entry["requestBody"] as Obj)["content"]).toMatchObject({ "multipart/form-data": { schema: { properties: { file: { type: "string", format: "binary" } }, required: ["file"], additionalProperties: false } } });
    expect(Object.keys(entry["responses"] as Obj).sort()).toEqual(["200", "400", "401", "403", "404", "409", "413", "415", "422", "429", "503"]);
    expect(JSON.stringify((entry["responses"] as Obj)["200"])).toContain("#/components/schemas/ImportResult");
    const parameters = entry["parameters"] as { name: string; in: string }[];
    expect(parameters.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name)).toEqual(["dryRun", "skipDuplicates"]);
  });
});

describe("the descriptions of the two imports", () => {
  const answerOf = (path: string): string => String((((document.paths[path]?.["post"] as Obj)["responses"] as Obj)["200"] as Obj)["description"]);
  const json = answerOf("/api/v1/import/json");
  const netscape = answerOf("/api/v1/import/netscape");

  it("tell the folders of the file apart: the JSON import makes every folder the file lists, the Netscape import only those a created link sits directly in", () => {
    expect(json).toContain("the folders and tags the file lists exist afterwards whether a bookmark uses them or not");
    expect(netscape).not.toContain("exist afterwards");
    expect(netscape).not.toContain("whether a bookmark uses them or not");
    expect(netscape).toContain("a folder that no created link sits directly in");
    expect(netscape).toContain("is not created");
  });

  it("leave the rules of a JSON file out of the Netscape import: it names no slug, forwarding, pinned state, description or plan-archived flag", () => {
    expect(netscape).not.toContain(json);
    for (const phrase of ["forwarding", "pinned", "plan-archived", "descriptions", "is dropped from its bookmark"]) {
      expect(json, phrase).toContain(phrase);
      expect(netscape, phrase).not.toContain(phrase);
    }
    expect(netscape).toContain("A file names no slug");
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

  it("accepts the shared list an export writes, in its strict entry shape, and no other", () => {
    expect(ImportRequestSchema.safeParse({ ...ENVELOPE, shared: [SHARED_ENTRY, { ...SHARED_ENTRY, description: "d", slug: null, ownerName: null }] }).success).toBe(true);
    expect(ImportEnvelopeSchema.safeParse({ ...ENVELOPE, shared: [] }).success).toBe(true);
    expect(document.components.schemas["ImportEnvelope"]).toMatchObject({ properties: { shared: { type: "array", items: { $ref: "#/components/schemas/ExportSharedBookmark" } } } });
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
      { ...ENVELOPE, shared: [""] },
      { ...ENVELOPE, shared: [{ ...SHARED_ENTRY, tags: ["private"] }] },
      { ...ENVELOPE, shared: [{ ...SHARED_ENTRY, shared: false }] },
      { ...ENVELOPE, shared: [{ ...SHARED_ENTRY, title: "t".repeat(301) }] },
      { ...ENVELOPE, shared: [{ ...SHARED_ENTRY, url: 1 }] },
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

  it("takes any number of folder and tag names on a bookmark, and a name or an icon of any length up to the bound, which is cut to its stored limit later", () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `n${String(index)}`);
    const url = "https://example.com/a";
    const issues = (body: unknown) => {
      const bookmark = Array.isArray(body) ? ImportBookmarkSchema.safeParse(body[0]) : ImportEnvelopeSchema.safeParse(body);
      return bookmark.error?.issues.map((issue) => [(Array.isArray(body) ? ["0", ...issue.path] : issue.path).join("."), issue.code]);
    };

    expect(ImportRequestSchema.safeParse([{ url, folders: names(250), tags: names(250) }]).success).toBe(true);
    expect(ImportRequestSchema.safeParse([{ url, folders: ["f".repeat(IMPORT_NAME_MAX_LENGTH)], tags: ["t".repeat(IMPORT_NAME_MAX_LENGTH)] }]).success).toBe(true);
    expect(issues([{ url, folders: ["f".repeat(IMPORT_NAME_MAX_LENGTH + 1)] }])).toEqual([["0.folders.0", "too_big"]]);
    expect(issues([{ url, tags: ["t".repeat(IMPORT_NAME_MAX_LENGTH + 1)] }])).toEqual([["0.tags.0", "too_big"]]);
    expect(ImportRequestSchema.safeParse({ ...ENVELOPE, tags: ["t".repeat(IMPORT_NAME_MAX_LENGTH)] }).success).toBe(true);
    expect(issues({ ...ENVELOPE, tags: ["t".repeat(IMPORT_NAME_MAX_LENGTH + 1)] })).toEqual([["tags.0", "too_big"]]);
    expect(ImportRequestSchema.safeParse({ ...ENVELOPE, folders: [{ name: "f".repeat(IMPORT_NAME_MAX_LENGTH), icon: "i".repeat(IMPORT_NAME_MAX_LENGTH) }] }).success).toBe(true);
    expect(issues({ ...ENVELOPE, folders: [{ name: "f".repeat(IMPORT_NAME_MAX_LENGTH + 1) }] })).toEqual([["folders.0.name", "too_big"]]);
    expect(issues({ ...ENVELOPE, folders: [{ name: "f", icon: "i".repeat(IMPORT_NAME_MAX_LENGTH + 1) }] })).toEqual([["folders.0.icon", "too_big"]]);
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
  it("takes dryRun and skipDuplicates as true or false, both optional, and no other member", () => {
    expect(ImportQuerySchema.safeParse({}).success).toBe(true);
    expect(ImportQuerySchema.safeParse({ dryRun: "true" }).success).toBe(true);
    expect(ImportQuerySchema.safeParse({ dryRun: "false", skipDuplicates: "false" }).success).toBe(true);
    for (const query of [{ dryRun: "1" }, { dryRun: "yes" }, { dryRun: "true", skipDuplicates: "maybe" }, { dryRun: "true", other: "1" }]) {
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
