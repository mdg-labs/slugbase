import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./generate-openapi.js";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
};

type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
  };
  paths: Record<
    string,
    {
      get?: {
        responses?: Record<
          string,
          {
            content?: Record<
              string,
              {
                schema?: JsonSchema;
              }
            >;
          }
        >;
      };
    }
  >;
};

describe("buildOpenApiDocument", () => {
  it("produces a valid OpenAPI document for the sample health contract", () => {
    const document = buildOpenApiDocument() as OpenApiDocument;

    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("SlugBase API");
    expect(document.paths["/health"]?.get).toBeDefined();
    expect(document.paths["/version"]?.get).toBeDefined();

    const healthResponse =
      document.paths["/health"]?.get?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema;

    expect(healthResponse).toMatchObject({
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok"] },
      },
      required: ["status"],
    });
  });
});
