import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApiDocument, OperationDeclarationError, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import {
  AUDIT_EVENT_CATEGORIES,
  defineOperation,
  EXPORT_DISPOSITION_PATTERN,
  ExportDocumentSchema,
  exportJson,
  jsonResponse,
  operations,
  problemResponse,
  streamResponse,
} from "../src/index.ts";

// The export of doc 04 section 10.9 and doc 02 sections 13.2 and 13.3: GET /api/v1/export/json is a member's read in the bulk bucket that an API token of the read scope may
// call. Its answer is a streamed `application/json` attachment whose whole body is the export document.

type Obj = Record<string, unknown>;
const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as { paths: Record<string, Record<string, Obj>>; components: { schemas: Record<string, Obj> } };
const documented = document.paths["/api/v1/export/json"]?.["get"] as Obj;

const BOOKMARK = {
  ref: "b1",
  url: "https://example.com/a",
  title: "A",
  description: null,
  slug: "a",
  forwarding: true,
  pinned: false,
  planArchived: false,
  folders: ["Reading"],
  tags: ["news"],
};
const EXPORT = {
  format: "slugbase-export",
  version: 1,
  exportedAt: "2026-11-02T10:00:00.000Z",
  workspace: { name: "Home" },
  folders: [{ name: "Reading", icon: "folder", color: 1 }],
  tags: ["news"],
  bookmarks: [BOOKMARK],
  goPreferences: [],
  shared: [],
};

describe("the export operation", () => {
  it("is GET /api/v1/export/json, a member's read in the bulk bucket that a read token may call", () => {
    expect(exportJson).toMatchObject({ method: "get", path: "/api/v1/export/json", operationId: "exportJson", tag: "export", auth: "member", rate: "bulk", scope: "read" });
    expect(exportJson).not.toHaveProperty("entitlement");
    expect(operations).toContain(exportJson);
    expect(documented).toMatchObject({ operationId: "exportJson", "x-slugbase-auth": "member", "x-slugbase-rate": "bulk", "x-slugbase-scope": "read" });
  });

  it("answers an application/json attachment whose body is the export document, with a dated file name that holds no workspace name", () => {
    const responses = documented["responses"] as Record<string, { content?: Obj; headers?: Record<string, { schema: { pattern: string } }> }>;
    expect(Object.keys(responses).sort()).toEqual(["200", "401", "404", "429", "503"]);
    expect(responses["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/ExportDocument" } } });
    const pattern = new RegExp(responses["200"]?.headers?.["Content-Disposition"]?.schema.pattern ?? "(none)");
    expect(pattern.test('attachment; filename="slugbase-export-2026-11-02.json"')).toBe(true);
    expect(pattern.test('attachment; filename="slugbase-export-Home.json"')).toBe(false);
    expect(EXPORT_DISPOSITION_PATTERN.test('attachment; filename="slugbase-export-2026-11-02.json"')).toBe(true);
  });

  it("publishes the document as a named component with closed objects", () => {
    for (const name of ["ExportDocument", "ExportBookmark", "ExportFolder"]) {
      expect(document.components.schemas[name]?.["additionalProperties"], name).toBe(false);
    }
  });
});

describe("the export document", () => {
  it("is the format, the version, the time, the workspace name, the folders, the tags, the bookmarks, the go preferences and the shared list", () => {
    expect(ExportDocumentSchema.parse(EXPORT)).toEqual(EXPORT);
    expect(Object.keys(ExportDocumentSchema.shape)).toEqual(["format", "version", "exportedAt", "workspace", "folders", "tags", "bookmarks", "goPreferences", "shared"]);
  });

  it("refuses another format, another version, and a member it does not declare", () => {
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, format: "other" }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, version: 2 }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, extra: true }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, workspace: { name: "Home", id: "x" } }).success).toBe(false);
  });

  it("holds no usage count, identifier or timestamp of a bookmark", () => {
    for (const member of ["id", "openCount", "createdAt", "updatedAt", "lastOpenedAt", "version", "ownerId"]) {
      expect(ExportDocumentSchema.safeParse({ ...EXPORT, bookmarks: [{ ...BOOKMARK, [member]: 1 }] }).success, member).toBe(false);
    }
  });

  it("names a bookmark by a ref of b and its position, and flags a plan-archived one", () => {
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, bookmarks: [{ ...BOOKMARK, ref: "b0" }] }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, bookmarks: [{ ...BOOKMARK, ref: "0192f3a0-aaaa-7000-8000-00000000a0b1" }] }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, bookmarks: [{ ...BOOKMARK, planArchived: true }] }).success).toBe(true);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, bookmarks: [{ ...BOOKMARK, planArchived: undefined }] }).success).toBe(false);
  });

  it("holds the icon and the colour of a folder once, in folders, and only names the folders and tags of a bookmark", () => {
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, folders: [{ name: "Reading", icon: "folder", color: 9 }] }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, bookmarks: [{ ...BOOKMARK, folders: [{ name: "Reading", icon: "folder", color: 1 }] }] }).success).toBe(false);
  });

  it("holds no go preferences and no shared bookmarks yet", () => {
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, goPreferences: [{ slug: "a", ref: "b1" }] }).success).toBe(false);
    expect(ExportDocumentSchema.safeParse({ ...EXPORT, shared: [{ url: "https://example.com/" }] }).success).toBe(false);
  });
});

describe("the export audit category", () => {
  it("is one the audit log filters by", () => {
    expect(AUDIT_EVENT_CATEGORIES).toContain("export");
  });
});

describe("a streamed response", () => {
  const base = { method: "get", path: "/api/v1/streams", operationId: "streamIt", tag: "streams", auth: "member", rate: "read" } as const;
  const problems = { 401: problemResponse("no session"), 429: exportJson.responses[429] } as const;

  it("is published with its schema as the body of its media type, or as opaque bytes without one", () => {
    const withSchema = defineOperation({ ...base, responses: { 200: streamResponse("rows", "application/json", { schema: z.strictObject({ n: z.number() }).meta({ id: "StreamRows" }) }), ...problems } });
    const without = defineOperation({ ...base, operationId: "streamBytes", path: "/api/v1/stream-bytes", responses: { 200: streamResponse("bytes", "text/csv"), ...problems } });
    const built = buildOpenApiDocument([withSchema, without]) as { paths: Record<string, { get: { responses: Record<string, { content: Obj }> } }> };
    expect(built.paths["/api/v1/streams"]?.get.responses["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/StreamRows" } } });
    expect(built.paths["/api/v1/stream-bytes"]?.get.responses["200"]?.content).toEqual({ "text/csv": { schema: { type: "string", format: "binary" } } });
  });

  it("is refused without a media type that names a type and a subtype, or with a schema that is not a Zod schema", () => {
    const refuse = (response: unknown): string => {
      try {
        buildOpenApiDocument([{ ...base, responses: { 200: response, ...problems } }]);
      } catch (error) {
        return error instanceof OperationDeclarationError ? error.message : "other";
      }
      return "accepted";
    };
    expect(refuse({ kind: "binary", stream: true, description: "x", mediaType: "json" })).toContain("needs a media type");
    expect(refuse({ kind: "binary", stream: true, description: "x", mediaType: "application/json", schema: { type: "object" } })).toContain("schema must be a Zod schema");
    expect(refuse(jsonResponse("ok", z.strictObject({})))).toBe("accepted");
  });
});
