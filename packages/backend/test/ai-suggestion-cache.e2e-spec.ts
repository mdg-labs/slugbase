import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AiService } from "@slugbase/shared-types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AI, OPENAI_HTTP } from "../src/ai/ai.tokens.js";
import { AiSuggestionCacheService } from "../src/ai/cache/ai-suggestion-cache.service.js";
import { AI_SUGGESTION_CACHE_TTL_MS } from "../src/ai/cache/ai-suggestion-cache.constants.js";
import type { OpenAiHttpExecutor } from "../src/ai/openai-ai.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

const WORKSPACE_A = "ws-cache-a";
const WORKSPACE_B = "ws-cache-b";
const USER_A = "user-cache-a";
const USER_B = "user-cache-b";

const MOCK_SUGGESTIONS = {
  title: "Cached Example",
  slug: "cached-example",
  tags: ["docs"],
  detectedLanguage: "en",
  confidence: 0.91,
};

function createOpenAiResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(MOCK_SUGGESTIONS) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("AI suggestion cache (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let cache: AiSuggestionCacheService;
  let ai: AiService;
  let httpExecutor: ReturnType<typeof vi.fn<OpenAiHttpExecutor>>;

  function mockOpenAiOnce(): void {
    httpExecutor.mockImplementationOnce(() => Promise.resolve(createOpenAiResponse()));
  }

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      OPENAI_API_KEY: "integration-test-openai-key",
    });

    httpExecutor = vi.fn<OpenAiHttpExecutor>();
    mockOpenAiOnce();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OPENAI_HTTP)
      .useValue(httpExecutor)
      .compile();

    cache = moduleRef.get(AiSuggestionCacheService);
    ai = moduleRef.get<AiService>(AI);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  const baseContext = {
    workspaceId: WORKSPACE_A,
    userId: USER_A,
  };

  const baseRequest = {
    url: "https://Example.com/docs/hit-test",
    outputLanguage: "en",
  };

  it("returns null on cache miss", async () => {
    const result = await cache.get(
      { workspaceId: "ws-miss", userId: "user-miss" },
      {
        url: "https://example.com/unique-miss",
        outputLanguage: "en",
      },
    );

    expect(result).toBeNull();
  });

  it("returns cached suggestions on hit without calling OpenAI again", async () => {
    httpExecutor.mockClear();
    mockOpenAiOnce();

    const first = await cache.suggestWithCache(baseContext, baseRequest, ai);
    expect(first).toEqual(MOCK_SUGGESTIONS);
    expect(httpExecutor).toHaveBeenCalledOnce();

    const second = await cache.suggestWithCache(baseContext, baseRequest, ai);
    expect(second).toEqual(MOCK_SUGGESTIONS);
    expect(httpExecutor).toHaveBeenCalledOnce();
  });

  it("treats URL variants with the same canonical form as one cache key", async () => {
    httpExecutor.mockClear();
    mockOpenAiOnce();

    const canonicalRequest = {
      url: "https://Example.com/canonical-key",
      outputLanguage: "en",
    };

    await cache.suggestWithCache(baseContext, canonicalRequest, ai);
    const hit = await cache.get(baseContext, {
      url: "  https://example.com/canonical-key  ",
      outputLanguage: "en",
    });

    expect(hit).toEqual(MOCK_SUGGESTIONS);
    expect(httpExecutor).toHaveBeenCalledOnce();
  });

  it("misses when output language differs", async () => {
    const germanHit = await cache.get(baseContext, {
      url: "https://example.com/docs/hit-test",
      outputLanguage: "de",
    });

    expect(germanHit).toBeNull();
  });

  it("misses when user differs within the same workspace", async () => {
    const otherUserHit = await cache.get(
      { workspaceId: WORKSPACE_A, userId: USER_B },
      baseRequest,
    );

    expect(otherUserHit).toBeNull();
  });

  it("misses when workspace differs for the same user", async () => {
    const otherWorkspaceHit = await cache.get(
      { workspaceId: WORKSPACE_B, userId: USER_A },
      baseRequest,
    );

    expect(otherWorkspaceHit).toBeNull();
  });

  it("expires entries after the configured TTL", async () => {
    httpExecutor.mockClear();
    mockOpenAiOnce();

    const expiredNow = Date.now() - AI_SUGGESTION_CACHE_TTL_MS - 1;
    const expiredRequest = {
      url: "https://example.com/expired-entry",
      outputLanguage: "en",
    };

    await cache.set(
      { workspaceId: "ws-expire", userId: "user-expire" },
      expiredRequest,
      MOCK_SUGGESTIONS,
      expiredNow,
    );

    const miss = await cache.get(
      { workspaceId: "ws-expire", userId: "user-expire" },
      expiredRequest,
    );
    expect(miss).toBeNull();

    const fresh = await cache.suggestWithCache(
      { workspaceId: "ws-expire", userId: "user-expire" },
      expiredRequest,
      ai,
    );
    expect(fresh).toEqual(MOCK_SUGGESTIONS);
    expect(httpExecutor).toHaveBeenCalledOnce();
  });
});
