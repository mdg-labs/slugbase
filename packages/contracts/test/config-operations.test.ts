import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { ApiConfigSchema, getApiConfig, getOpenApiDocument } from "../src/operations/meta.ts";
import { operations } from "../src/operations/index.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const paths = document["paths"] as Record<string, Record<string, Obj>>;
const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;

const config = {
  apiVersion: "v1",
  origin: "https://cloud.slugbase.app",
  product: { name: "SlugBase", version: "1.4.2" },
  locales: ["en", "de"],
  defaultLocale: "en",
  docsBaseUrl: "https://slugbase.app/docs",
  features: { mail: true, ai: false },
};

describe("getApiConfig", () => {
  const operation = paths["/api/config"]?.["get"];

  it("is declared anonymous in the public bucket and is not token-callable", () => {
    expect(getApiConfig.path).toBe("/api/config");
    expect(operation?.["operationId"]).toBe("getApiConfig");
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("public");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
  });

  it("documents Cache-Control: public, max-age=60 on the success response", () => {
    const ok = (operation?.["responses"] as Record<string, Obj>)["200"];
    const headers = ok?.["headers"] as Record<string, { required: boolean; schema: Obj }>;
    expect(headers["Cache-Control"]?.schema).toMatchObject({ type: "string", const: "public, max-age=60" });
    expect(headers["Cache-Control"]?.required).toBe(true);
  });

  it("responds with the named ApiConfig schema", () => {
    const ok = (operation?.["responses"] as Record<string, { content: Obj }>)["200"];
    expect(ok?.content["application/json"]).toEqual({ schema: { $ref: "#/components/schemas/ApiConfig" } });
    expect(schemas["ApiConfig"]).toBeDefined();
  });

  it("closes every object of the schema", () => {
    const api = schemas["ApiConfig"] as { additionalProperties: unknown; properties: Record<string, Obj> };
    expect(api.additionalProperties).toBe(false);
    expect(api.properties["product"]?.["additionalProperties"]).toBe(false);
    expect(api.properties["features"]?.["additionalProperties"]).toBe(false);
  });

  it("carries exactly the fields a server without accounts can answer, and the setup answers besides", () => {
    const api = schemas["ApiConfig"] as { properties: Obj; required: string[] };
    const names = ["apiVersion", "defaultLocale", "docsBaseUrl", "features", "locales", "origin", "product"];
    expect(Object.keys(api.properties).sort()).toEqual([...names, "setupRequired", "setupTokenRequired", "signIn"].sort());
    expect([...api.required].sort()).toEqual(names);
    expect(api.properties["setupRequired"]).toMatchObject({ type: "boolean" });
    expect(api.properties["setupTokenRequired"]).toMatchObject({ type: "boolean" });
    const signIn = api.properties["signIn"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(signIn.additionalProperties).toBe(false);
    expect(Object.keys(signIn.properties).sort()).toEqual(["oidc", "registration"]);
    expect([...signIn.required].sort()).toEqual(["oidc", "registration"]);
    expect(signIn.properties["registration"]).toMatchObject({ type: "boolean" });
    const provider = (signIn.properties["oidc"] as { type: string; items: { additionalProperties: unknown; properties: Obj; required: string[] } });
    expect(provider.type).toBe("array");
    expect(provider.items.additionalProperties).toBe(false);
    expect(Object.keys(provider.items.properties).sort()).toEqual(["name", "slug"]);
    expect([...provider.items.required].sort()).toEqual(["name", "slug"]);
    const features = api.properties["features"] as { properties: Obj; required: string[] };
    expect(Object.keys(features.properties).sort()).toEqual(["ai", "mail"]);
    expect([...features.required].sort()).toEqual(["ai", "mail"]);
  });
});

describe("ApiConfigSchema", () => {
  it("accepts the bootstrap document", () => {
    expect(ApiConfigSchema.parse(config)).toEqual(config);
  });

  it("rejects fields that need accounts or an entitlement", () => {
    expect(ApiConfigSchema.safeParse({ ...config, signIn: { password: true } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, features: { ...config.features, billing: true } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, product: { ...config.product, commit: "abc" } }).success).toBe(false);
  });

  it("accepts signIn.oidc as a list of slug and name, and leaves it out of a document that does not state it", () => {
    const signIn = { registration: false, oidc: [{ slug: "google", name: "Google" }] };
    expect(ApiConfigSchema.parse({ ...config, signIn })).toEqual({ ...config, signIn });
    expect(ApiConfigSchema.parse({ ...config, signIn: { registration: false, oidc: [] } })).toEqual({ ...config, signIn: { registration: false, oidc: [] } });
    expect(ApiConfigSchema.safeParse({ ...config, signIn: { registration: false, oidc: [{ slug: "google", name: "Google", issuerUrl: "https://x.example.com" }] } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, signIn: { registration: false, oidc: [{ slug: "google" }] } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, signIn: {} }).success).toBe(false);
  });

  it("accepts signIn.registration as a boolean and requires it beside signIn.oidc", () => {
    expect(ApiConfigSchema.parse({ ...config, signIn: { registration: true, oidc: [] } })).toEqual({ ...config, signIn: { registration: true, oidc: [] } });
    expect(ApiConfigSchema.safeParse({ ...config, signIn: { registration: "yes", oidc: [] } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, signIn: { oidc: [] } }).success).toBe(false);
  });

  it("accepts setupRequired as a boolean, and leaves it out of a document that does not state it", () => {
    expect(ApiConfigSchema.parse({ ...config, setupRequired: true })).toEqual({ ...config, setupRequired: true });
    expect(ApiConfigSchema.safeParse({ ...config, setupRequired: "yes" }).success).toBe(false);
    expect(ApiConfigSchema.parse({ ...config, setupTokenRequired: true })).toEqual({ ...config, setupTokenRequired: true });
    expect(ApiConfigSchema.safeParse({ ...config, setupTokenRequired: "token" }).success).toBe(false);
  });

  it("rejects an API version other than v1 and non-boolean features", () => {
    expect(ApiConfigSchema.safeParse({ ...config, apiVersion: "v2" }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, features: { mail: "yes", ai: false } }).success).toBe(false);
  });
});

describe("getOpenApiDocument", () => {
  const operation = paths["/api/v1/openapi.json"]?.["get"];

  it("is declared anonymous in the public bucket", () => {
    expect(getOpenApiDocument.path).toBe("/api/v1/openapi.json");
    expect(operation?.["operationId"]).toBe("getOpenApiDocument");
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("public");
  });

  it("returns an OpenAPI document and answers 404 when the docs are disabled", () => {
    const responses = operation?.["responses"] as Record<string, { content?: Obj }>;
    expect(responses["200"]?.content?.["application/json"]).toEqual({
      schema: { $ref: "#/components/schemas/OpenApiDocument" },
    });
    expect(responses["404"]?.content?.["application/problem+json"]).toBeDefined();
    const doc = schemas["OpenApiDocument"] as { required: string[] };
    expect([...doc.required].sort()).toEqual(["info", "openapi", "paths"]);
  });

  it("does not claim a cache policy", () => {
    const ok = (operation?.["responses"] as Record<string, Obj>)["200"];
    expect(ok?.["headers"]).toBeUndefined();
  });
});
