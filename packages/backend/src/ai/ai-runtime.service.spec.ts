import { describe, expect, it } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import { AiRuntimeService } from "./ai-runtime.service.js";

function createConfig(overrides: Partial<Record<string, string>> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: "gpt-4o-mini",
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

describe("AiRuntimeService", () => {
  it("reports env configured when OPENAI_API_KEY is set", () => {
    const service = new AiRuntimeService(createConfig({ OPENAI_API_KEY: "sk-test" }));
    expect(service.isEnvConfigured()).toBe(true);
    expect(service.getConfiguredModel()).toBe("gpt-4o-mini");
  });

  it("reports env not configured when OPENAI_API_KEY is absent", () => {
    const service = new AiRuntimeService(createConfig());
    expect(service.isEnvConfigured()).toBe(false);
    expect(service.getConfiguredModel()).toBe("gpt-4o-mini");
  });
});
