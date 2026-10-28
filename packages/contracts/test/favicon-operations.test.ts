import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OperationDeclarationError, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import {
  binaryResponse,
  defineOperation,
  FaviconParamsSchema,
  FaviconQuerySchema,
  getFavicon,
  operations,
  problemResponse,
  type OperationDefinition,
} from "../src/index.ts";

// The favicon operation in the contract (doc 04 sections 7 and 10.6, doc 02 section 5.4, doc 10 T6 and T14): a GET of a member at /api/v1/favicons/{host}, in the `fetch`
// bucket taken by its handler, whose answers are `image/png` bodies with `nosniff` and a private cache, never JSON; the host is a lower-case host name.

type Obj = Record<string, unknown>;
const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as { paths: Record<string, Record<string, Obj>> };
const documented = document.paths["/api/v1/favicons/{host}"]?.["get"] as Obj;

describe("the favicon operation", () => {
  it("is a GET of a member at /api/v1/favicons/{host}, in the fetch bucket, with no token scope", () => {
    expect(getFavicon).toMatchObject({ method: "get", path: "/api/v1/favicons/{host}", operationId: "getFavicon", auth: "member", rate: "fetch" });
    expect(getFavicon).not.toHaveProperty("scope");
    expect(operations).toContain(getFavicon);
    expect(documented).toMatchObject({ operationId: "getFavicon", "x-slugbase-auth": "member", "x-slugbase-rate": "fetch" });
    expect(documented).not.toHaveProperty("x-slugbase-scope");
  });

  it("keeps the server-side rate declaration out of the published document", () => {
    expect(getFavicon.rateTakenByHandler).toBe(true);
    expect(JSON.stringify(documented)).not.toContain("rateTakenByHandler");
  });

  it("answers image/png bodies only, with nosniff and a private cache, and no JSON", () => {
    const responses = documented["responses"] as Record<string, Obj>;
    for (const status of ["200", "202"]) {
      const response = responses[status] as { content: Obj; headers: Record<string, { schema: { const: string } }> };
      expect(Object.keys(response.content)).toEqual(["image/png"]);
      expect(response.content["image/png"]).toEqual({ schema: { type: "string", format: "binary" } });
      expect(response.headers["X-Content-Type-Options"]?.schema.const).toBe("nosniff");
      expect(response.headers["Cache-Control"]?.schema.const).toMatch(/^private, max-age=\d+$/);
    }
    expect((responses["200"] as { headers: Record<string, { schema: { const: string } }> }).headers["Cache-Control"]?.schema.const).toBe("private, max-age=604800");
    expect((responses["202"] as { headers: Record<string, { schema: { const: string } }> }).headers["Cache-Control"]?.schema.const).toBe("private, max-age=60");
    expect(JSON.stringify(responses)).not.toContain("svg");
    expect(Object.keys(responses).sort()).toEqual(["200", "202", "401", "403", "404", "422", "429", "503"]);
  });
});

describe("the host of the favicon operation", () => {
  const accepted = ["example.com", "a.b.c.example.co.uk", "localhost", "xn--bcher-kva.example", "my-site.example", "1.2.3.4", "a".repeat(63), `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`];
  const refused = [
    "",
    "Example.com",
    "example.com.",
    "example.com:8080",
    "example.com/path",
    "user@example.com",
    "exa mple.com",
    "ex_ample.com",
    "-example.com",
    "example-.com",
    "example..com",
    ".example.com",
    "[::1]",
    "münchen.example",
    "a".repeat(64),
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
    "example.com\n",
    "<script>.example",
  ];

  it.each(accepted)("accepts %s", (host) => {
    expect(FaviconParamsSchema.safeParse({ host }).success).toBe(true);
  });

  it.each(refused)("refuses %j", (host) => {
    expect(FaviconParamsSchema.safeParse({ host }).success).toBe(false);
  });

  it("takes no other parameter, and a size of 32 or 64", () => {
    expect(FaviconParamsSchema.safeParse({ host: "example.com", extra: 1 }).success).toBe(false);
    expect(FaviconQuerySchema.safeParse({}).success).toBe(true);
    expect(FaviconQuerySchema.safeParse({ size: "32" }).success).toBe(true);
    expect(FaviconQuerySchema.safeParse({ size: "64" }).success).toBe(true);
    for (const size of ["16", "48", "128", "0", "", "64px", 64]) {
      expect(FaviconQuerySchema.safeParse({ size }).success).toBe(false);
    }
    expect(FaviconQuerySchema.safeParse({ size: "32", other: "x" }).success).toBe(false);
  });
});

describe("a binary response in a declaration", () => {
  const base = {
    method: "get",
    path: "/api/v1/images",
    operationId: "getImage",
    tag: "images",
    auth: "member",
    rate: "read",
    responses: { 200: binaryResponse("an image", "image/png"), 422: problemResponse("invalid") },
  } as const satisfies OperationDefinition;

  it("is published as its media type with a binary string schema", () => {
    const built = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument([defineOperation(base)]))) as { paths: Record<string, Record<string, { responses: Obj }>> };
    expect(built.paths["/api/v1/images"]?.["get"]?.responses["200"]).toEqual({
      description: "an image",
      content: { "image/png": { schema: { type: "string", format: "binary" } } },
    });
  });

  it("is refused without a media type that looks like one", () => {
    for (const mediaType of ["", "png", "image/", "IMAGE/PNG", "image/png; charset=x"]) {
      let problems: readonly string[] = [];
      try {
        buildOpenApiDocument([{ ...base, responses: { 200: { kind: "binary", description: "an image", mediaType }, 422: problemResponse("invalid") } }]);
      } catch (error) {
        problems = error instanceof OperationDeclarationError ? error.problems : [];
      }
      expect(problems.join("\n"), mediaType).toContain("needs a media type");
    }
  });
});
