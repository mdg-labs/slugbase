import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config/env.schema.js";
import { ConfigService } from "../config/config.service.js";
import { OpenapiService } from "./openapi.service.js";

type OpenApiPathItem = {
  get?: unknown;
};

type OpenApiDocument = {
  openapi: string;
  info: { title: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, OpenApiPathItem>;
};

function createConfig(overrides: Partial<AppConfig> = {}): ConfigService {
  const config = {
    APP_BASE_URL: "https://api.slugbase.test",
    OPENAPI_INTERACTIVE_DOCS: true,
    ...overrides,
  } as AppConfig;

  return new ConfigService(config);
}

describe("OpenapiService", () => {
  it("builds an OpenAPI document from ts-rest contracts with the configured server URL", () => {
    const service = new OpenapiService(
      createConfig({ APP_BASE_URL: "https://api.example.com" }),
    );

    const document = service.getDocument() as OpenApiDocument;

    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("SlugBase API");
    expect(document.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(document.paths["/health"]?.get).toBeDefined();
  });

  it("returns the same cached document on subsequent calls", () => {
    const service = new OpenapiService(createConfig());

    expect(service.getDocument()).toBe(service.getDocument());
  });
});
