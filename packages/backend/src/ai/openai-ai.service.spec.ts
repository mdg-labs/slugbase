import { describe, expect, it, vi } from "vitest";

import type { CryptoService } from "@slugbase/shared-types";

import type { ConfigService } from "../config/config.service.js";
import { OpenAiAiService } from "./openai-ai.service.js";

function createConfig(overrides: Partial<Record<string, string>> = {}) {
  const values: Record<string, string | undefined> = {
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_MODEL: "gpt-4o-mini",
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

function createCrypto(): CryptoService {
  return {
    encrypt: vi.fn(),
    decrypt: vi.fn((value: string) => `decrypted:${value}`),
  };
}

describe("OpenAiAiService", () => {
  it("reports unavailable when no API key is configured", () => {
    const service = new OpenAiAiService(
      createConfig({ OPENAI_API_KEY: undefined }),
      createCrypto(),
      vi.fn(),
    );

    expect(service.isAvailable()).toBe(false);
  });

  it("returns parsed suggestions from OpenAI JSON", async () => {
    const http = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "Example Docs",
                  slug: "example-docs",
                  tags: ["docs", "reference"],
                  detectedLanguage: "en",
                  confidence: 0.91,
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const service = new OpenAiAiService(createConfig(), createCrypto(), http);
    const result = await service.suggest({
      url: "https://example.com/docs",
      outputLanguage: "en",
      metadata: { title: "Example" },
    });

    expect(result).toEqual({
      title: "Example Docs",
      slug: "example-docs",
      tags: ["docs", "reference"],
      detectedLanguage: "en",
      confidence: 0.91,
    });
    expect(http).toHaveBeenCalledOnce();
  });

  it("reconfigures from encrypted credentials", async () => {
    const http = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "Nach Docs",
                  slug: "nach-docs",
                  tags: ["docs"],
                  detectedLanguage: "de",
                  confidence: 0.8,
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const service = new OpenAiAiService(
      createConfig({ OPENAI_API_KEY: undefined }),
      createCrypto(),
      http,
    );
    expect(service.isAvailable()).toBe(false);

    service.reconfigureFromEncrypted("cipher-text", "gpt-4o-mini");
    expect(service.isAvailable()).toBe(true);

    await service.suggest({
      url: "https://example.com/de",
      outputLanguage: "de",
    });

    expect(http).toHaveBeenCalledOnce();
  });
});
