import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AiService } from "@slugbase/shared-types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AI, OPENAI_HTTP } from "../src/ai/ai.tokens.js";
import type { OpenAiHttpExecutor } from "../src/ai/openai-ai.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

function createOpenAiResponse(payload: {
  title: string;
  slug: string;
  tags: string[];
  detectedLanguage: string;
  confidence: number;
}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(payload),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("AI interface (integration)", () => {
  describe("without OPENAI_API_KEY", () => {
    let app: INestApplication | undefined;
    let ai: AiService;
    let cleanup: () => Promise<void> = async () => {};

    beforeAll(async () => {
      const testDatabase = await createTestDatabase();
      cleanup = testDatabase.cleanup;
      await runMigrations(testDatabase.databaseUrl);
      applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      ai = moduleRef.get<AiService>(AI);
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      if (app) await app.close();
      clearTestEnv();
      await cleanup();
    });

    it("is disabled when no key is configured", () => {
      expect(ai.isAvailable()).toBe(false);
    });

    it("rejects suggestions when no key is configured", async () => {
      await expect(
        ai.suggest({
          url: "https://example.com",
          outputLanguage: "en",
        }),
      ).rejects.toMatchObject({ name: "AiUnavailableError" });
    });
  });

  describe("with mocked OpenAI", () => {
    let app: INestApplication | undefined;
    let ai: AiService;
    let cleanup: () => Promise<void> = async () => {};
    let httpExecutor: ReturnType<typeof vi.fn<OpenAiHttpExecutor>>;

    beforeAll(async () => {
      const testDatabase = await createTestDatabase();
      cleanup = testDatabase.cleanup;
      await runMigrations(testDatabase.databaseUrl);
      applyTestEnv({
        DATABASE_URL: testDatabase.databaseUrl,
        OPENAI_API_KEY: "integration-test-openai-key",
      });

      httpExecutor = vi.fn<OpenAiHttpExecutor>().mockResolvedValue(
        createOpenAiResponse({
          title: "Example Documentation",
          slug: "example-docs",
          tags: ["docs", "guide"],
          detectedLanguage: "en",
          confidence: 0.88,
        }),
      );

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(OPENAI_HTTP)
        .useValue(httpExecutor)
        .compile();

      ai = moduleRef.get<AiService>(AI);
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      if (app) await app.close();
      clearTestEnv();
      await cleanup();
    });

    it("returns suggestions when OpenAI is configured", async () => {
      expect(ai.isAvailable()).toBe(true);

      const result = await ai.suggest({
        url: "https://example.com/docs",
        outputLanguage: "en",
        metadata: {
          title: "Example",
          description: "Documentation site",
        },
      });

      expect(result).toEqual({
        title: "Example Documentation",
        slug: "example-docs",
        tags: ["docs", "guide"],
        detectedLanguage: "en",
        confidence: 0.88,
      });
      expect(httpExecutor).toHaveBeenCalledOnce();
    });
  });
});
