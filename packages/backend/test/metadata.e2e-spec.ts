import "reflect-metadata";

import { ForbiddenException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { MetadataService } from "../src/bookmarks/metadata/metadata.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import {
  FetchService,
  type HttpExecutor,
} from "../src/fetch/fetch.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

const publicLookup = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }] as const);

function createMockResponse(
  body: Uint8Array,
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe("Bookmark metadata (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let metadataService: MetadataService;
  let httpExecutor: ReturnType<typeof vi.fn<HttpExecutor>>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    httpExecutor = vi.fn<HttpExecutor>();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(FetchService)
      .useFactory({
        factory: () =>
          new FetchService({
            httpExecutor,
            lookup: publicLookup,
            cacheTtlMs: 60_000,
          }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    metadataService = moduleRef.get(MetadataService);
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  it("parses metadata from fetched HTML", async () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Ignored</title>
    <meta property="og:title" content="Parsed Title" />
    <meta property="og:description" content="Parsed description" />
    <meta property="og:site_name" content="Parsed Site" />
    <link rel="icon" href="/icon.png" />
  </head>
</html>`;

    httpExecutor.mockResolvedValueOnce(
      createMockResponse(new TextEncoder().encode(html), {
        url: "https://example.com/article",
      }),
    );

    const metadata = await metadataService.fetchMetadata(
      "https://example.com/article",
    );

    expect(metadata).toEqual({
      title: "Parsed Title",
      description: "Parsed description",
      siteName: "Parsed Site",
      faviconUrl: "https://example.com/icon.png",
    });
    expect(httpExecutor).toHaveBeenCalledTimes(1);
  });

  it("blocks private URLs before outbound fetch", async () => {
    httpExecutor.mockClear();

    await expect(
      metadataService.fetchMetadata("http://192.168.0.10/internal"),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(httpExecutor).not.toHaveBeenCalled();
  });

  it("returns cached metadata on repeated fetch", async () => {
    const html =
      '<html><head><meta property="og:title" content="Cached" /></head></html>';

    httpExecutor.mockResolvedValue(
      createMockResponse(new TextEncoder().encode(html), {
        url: "https://example.com/cached-page",
      }),
    );

    await metadataService.fetchMetadata("https://example.com/cached-page");
    await metadataService.fetchMetadata("https://example.com/cached-page");

    expect(httpExecutor).toHaveBeenCalledTimes(1);
  });
});
