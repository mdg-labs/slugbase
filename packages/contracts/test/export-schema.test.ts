import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExportDocumentSchema } from "../src/index.ts";

// The JSON Schema of the SlugBase export format (doc 02 section 13.3, doc 04 section 10.9), as committed in generated/slugbase-export.schema.json. The validator is the
// ajv that the Spectral packages of this package already bring; the package declares none of its own, so it is loaded from where Spectral resolves it.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Validate = (data: unknown) => boolean;
interface AjvInstance {
  compile(schema: unknown): Validate & { errors?: { instancePath: string; message?: string }[] | null };
}

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(readFileSync(join(packageDir, "generated/slugbase-export.schema.json"), "utf8")) as Record<string, unknown>;
const fromSpectral = createRequire(createRequire(join(packageDir, "package.json")).resolve("@stoplight/spectral-core"));
const Ajv2020 = (fromSpectral("ajv/dist/2020") as { default: new (options: { strict: boolean }) => AjvInstance }).default;
const addFormats = (fromSpectral("ajv-formats") as { default: (ajv: AjvInstance) => void }).default;
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function document(): { [key: string]: Json } {
  return {
    format: "slugbase-export",
    version: 1,
    exportedAt: "2026-11-02T10:00:00.000Z",
    workspace: { name: "Home" },
    folders: [{ name: "Reading", icon: "folder", color: 3 }],
    tags: ["news"],
    bookmarks: [
      {
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
      },
      {
        ref: "b2",
        url: "https://example.com/b",
        title: "B",
        description: "About B",
        slug: null,
        forwarding: false,
        pinned: true,
        planArchived: true,
        folders: [],
        tags: [],
      },
    ],
    goPreferences: [],
    shared: [],
  };
}

function bookmark(doc: { [key: string]: Json }): { [key: string]: Json } {
  return (doc["bookmarks"] as { [key: string]: Json }[])[0] as { [key: string]: Json };
}

describe("the generated JSON Schema of the export format", () => {
  it("accepts a document the Zod definition accepts", () => {
    const doc = document();
    expect(ExportDocumentSchema.safeParse(doc).success).toBe(true);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts an empty export", () => {
    const doc = { ...document(), folders: [], tags: [], bookmarks: [] };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses version 2", () => {
    const doc = { ...document(), version: 2 };
    expect(ExportDocumentSchema.safeParse(doc).success).toBe(false);
    expect(validate(doc)).toBe(false);
    expect(validate.errors?.some((error) => error.instancePath === "/version")).toBe(true);
  });

  it("refuses a field the format does not declare, at the document, a folder, a bookmark and the workspace", () => {
    const atDocument = { ...document(), extra: 1 };
    const atFolder = document();
    (atFolder["folders"] as { [key: string]: Json }[])[0] = { name: "Reading", icon: "folder", color: 3, extra: 1 };
    const atBookmark = document();
    bookmark(atBookmark)["extra"] = 1;
    const atWorkspace = { ...document(), workspace: { name: "Home", extra: 1 } };
    for (const doc of [atDocument, atFolder, atBookmark, atWorkspace]) {
      expect(ExportDocumentSchema.safeParse(doc).success).toBe(false);
      expect(validate(doc)).toBe(false);
    }
  });

  it("refuses a missing member and a wrong format", () => {
    const withoutShared = document();
    delete withoutShared["shared"];
    expect(validate(withoutShared)).toBe(false);
    expect(validate({ ...document(), format: "other" })).toBe(false);
  });

  it("refuses an entry in the list of go preferences, which this release writes empty", () => {
    expect(validate({ ...document(), goPreferences: [{}] })).toBe(false);
  });

  it("accepts the shared bookmarks as the readable fields and the flag, and refuses an entry that holds more or less", () => {
    const entry = { url: "https://example.com/theirs", title: "Theirs", description: null, slug: null, ownerName: null, shared: true };
    const doc = { ...document(), shared: [entry, { ...entry, description: "d", slug: "s", ownerName: "Olga Owner" }] };
    expect(ExportDocumentSchema.safeParse(doc).success).toBe(true);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    for (const refused of [{}, { ...entry, tags: ["private"] }, { ...entry, folders: [] }, { ...entry, pinned: false }, { ...entry, shared: false }, { ...entry, title: "t".repeat(301) }, { ...entry, ownerName: "o".repeat(101) }]) {
      expect(validate({ ...document(), shared: [refused] }), JSON.stringify(refused)).toBe(false);
    }
  });

  it("refuses a bookmark reference that is not b and a position", () => {
    const doc = document();
    bookmark(doc)["ref"] = "b0";
    expect(ExportDocumentSchema.safeParse(doc).success).toBe(false);
    expect(validate(doc)).toBe(false);
  });

  it("refuses a timestamp that is not an instant in UTC", () => {
    expect(validate({ ...document(), exportedAt: "yesterday" })).toBe(false);
    expect(validate({ ...document(), exportedAt: "2026-11-02T10:00:00+01:00" })).toBe(false);
  });
});
