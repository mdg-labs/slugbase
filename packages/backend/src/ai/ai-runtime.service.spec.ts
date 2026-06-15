import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import type { DbService } from "../db/db.service.js";
import { AiRuntimeService } from "./ai-runtime.service.js";
import type { OpenAiAiService } from "./openai-ai.service.js";

function createDbService(rows: Array<{ value: string }>): MockedObject<DbService> {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return {
    getOrm: vi.fn().mockReturnValue({ select }),
  } as unknown as MockedObject<DbService>;
}

function createConfig(envKey?: string): ConfigService {
  return {
    get: (key: string) => (key === "OPENAI_API_KEY" ? envKey : undefined),
  } as ConfigService;
}

function createOpenAi(): MockedObject<OpenAiAiService> {
  return {
    reconfigureFromEncrypted: vi.fn(),
    clearCredentials: vi.fn(),
  } as unknown as MockedObject<OpenAiAiService>;
}

describe("AiRuntimeService", () => {
  it("applies DB credentials on bootstrap when env key is absent", async () => {
    const openAi = createOpenAi();
    const stored = {
      provider: "openai",
      encryptedApiKey: "cipher",
      model: "gpt-4o-mini",
      enabled: true,
    };
    const service = new AiRuntimeService(
      createConfig(undefined),
      createDbService([{ value: JSON.stringify(stored) }]),
      openAi,
    );

    await service.onModuleInit();

    expect(service.isInstanceEnabled()).toBe(true);
    expect(openAi.reconfigureFromEncrypted).toHaveBeenCalledWith(
      "cipher",
      "gpt-4o-mini",
    );
    expect(openAi.clearCredentials).not.toHaveBeenCalled();
  });

  it("skips DB credentials when env key is set at startup", async () => {
    const openAi = createOpenAi();
    const stored = {
      provider: "openai",
      encryptedApiKey: "cipher",
      model: "gpt-4o-mini",
      enabled: true,
    };
    const service = new AiRuntimeService(
      createConfig("env-openai-key"),
      createDbService([{ value: JSON.stringify(stored) }]),
      openAi,
    );

    await service.onModuleInit();

    expect(service.isInstanceEnabled()).toBe(true);
    expect(openAi.reconfigureFromEncrypted).not.toHaveBeenCalled();
    expect(openAi.clearCredentials).not.toHaveBeenCalled();
  });

  it("clears credentials when disabled without env key", async () => {
    const openAi = createOpenAi();
    const stored = {
      provider: "openai",
      encryptedApiKey: "cipher",
      model: "gpt-4o-mini",
      enabled: false,
    };
    const service = new AiRuntimeService(
      createConfig(undefined),
      createDbService([{ value: JSON.stringify(stored) }]),
      openAi,
    );

    await service.onModuleInit();

    expect(service.isInstanceEnabled()).toBe(false);
    expect(openAi.clearCredentials).toHaveBeenCalledOnce();
    expect(openAi.reconfigureFromEncrypted).not.toHaveBeenCalled();
  });
});
