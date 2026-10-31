import { describe, expect, it } from "vitest";
import { AI_KEYS, ConfigError, loadConfig } from "../../src/config/index.ts";
import { productionEnv } from "./support.ts";

const AI = {
  AI_BASE_URL: "https://api.example.com/v1",
  AI_API_KEY: "provider-key-qx86-visible",
  AI_MODEL: "small-model",
  AI_PROVIDER_NAME: "Example AI",
};

function issues(overrides: Record<string, string | undefined>, type: "server" | "worker" = "server"): { key: string; message: string }[] {
  try {
    loadConfig(type, productionEnv(overrides));
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...error.issues];
    }
    throw error;
  }
  return [];
}

const keysOf = (overrides: Record<string, string | undefined>): string[] => issues(overrides).map((issue) => issue.key).sort();

describe("the AI keys", () => {
  it("leave AI suggestions unconfigured when none is set, or all are empty", () => {
    const { config } = loadConfig("server", productionEnv());
    for (const key of AI_KEYS) {
      expect(config[key]).toBeUndefined();
    }
    const empty = loadConfig("server", productionEnv(Object.fromEntries(AI_KEYS.map((key) => [key, ""])))).config;
    expect(empty.AI_BASE_URL).toBeUndefined();
  });

  it("parse when set, with the base URL without its trailing slashes", () => {
    expect(loadConfig("server", productionEnv({ ...AI, AI_BASE_URL: "https://api.example.com/v1//" })).config).toMatchObject({
      ...AI,
      AI_BASE_URL: "https://api.example.com/v1",
    });
  });

  it("do not belong to the worker or the migrate command", () => {
    expect(loadConfig("worker", productionEnv(AI)).config).not.toHaveProperty("AI_BASE_URL");
    expect(loadConfig("migrate", productionEnv(AI)).config).not.toHaveProperty("AI_MODEL");
  });

  it("take no API key: an endpoint without credentials is allowed", () => {
    const config = loadConfig("server", productionEnv({ ...AI, AI_API_KEY: undefined })).config;
    expect(config.AI_API_KEY).toBeUndefined();
    expect(config.AI_BASE_URL).toBe("https://api.example.com/v1");
  });

  it.each(["AI_BASE_URL", "AI_MODEL", "AI_PROVIDER_NAME"] as const)("refuse a set without %s, naming exactly that key", (missing) => {
    expect(keysOf({ ...AI, [missing]: undefined })).toEqual([missing]);
  });

  it("name every missing key of a partial set, and refuse a key or an allowance alone", () => {
    expect(keysOf({ AI_API_KEY: AI.AI_API_KEY })).toEqual(["AI_BASE_URL", "AI_MODEL", "AI_PROVIDER_NAME"]);
    expect(keysOf({ AI_BASE_URL: AI.AI_BASE_URL })).toEqual(["AI_MODEL", "AI_PROVIDER_NAME"]);
  });

  it.each([
    ["a relative URL", "api.example.com/v1"],
    ["another scheme", "ftp://api.example.com/v1"],
    ["credentials in the URL", "https://user:pw@api.example.com/v1"],
    ["a query", "https://api.example.com/v1?key=1"],
    ["a fragment", "https://api.example.com/v1#x"],
    ["an empty query", "https://api.example.com/v1?"],
  ])("refuse an AI_BASE_URL with %s", (_label, value) => {
    expect(keysOf({ ...AI, AI_BASE_URL: value })).toEqual(["AI_BASE_URL"]);
  });

  it.each([
    ["a space", "key with space"],
    ["a line break", "key\nnext"],
    ["a non-ASCII character", "schlüssel"],
    ["a length over 512", "k".repeat(513)],
  ])("refuse an AI_API_KEY with %s", (_label, value) => {
    expect(keysOf({ ...AI, AI_API_KEY: value })).toEqual(["AI_API_KEY"]);
  });

  it.each([
    ["AI_MODEL", "a model"],
    ["AI_MODEL", "m".repeat(201)],
    ["AI_PROVIDER_NAME", "x".repeat(65)],
    ["AI_PROVIDER_NAME", "line\nbreak"],
    ["AI_PROVIDER_NAME", "   "],
  ])("refuse %s %j", (key, value) => {
    expect(keysOf({ ...AI, [key]: value })).toEqual([key]);
  });

  it("trim the provider name members see", () => {
    expect(loadConfig("server", productionEnv({ ...AI, AI_PROVIDER_NAME: "  Example AI " })).config.AI_PROVIDER_NAME).toBe("Example AI");
  });
});

describe("AI_ALLOWED_PRIVATE_HOST", () => {
  const LAN = { ...AI, AI_BASE_URL: "http://llm.lan:11434/v1" };

  it("is optional and, when set to the host of AI_BASE_URL, is accepted", () => {
    expect(loadConfig("server", productionEnv(LAN)).config.AI_ALLOWED_PRIVATE_HOST).toBeUndefined();
    expect(loadConfig("server", productionEnv({ ...LAN, AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).config.AI_ALLOWED_PRIVATE_HOST).toBe("llm.lan");
  });

  it("refuses to start when it is set without AI_BASE_URL", () => {
    expect(keysOf({ AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).toEqual(["AI_BASE_URL", "AI_MODEL", "AI_PROVIDER_NAME"]);
    expect(keysOf({ AI_MODEL: AI.AI_MODEL, AI_PROVIDER_NAME: AI.AI_PROVIDER_NAME, AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).toEqual(["AI_BASE_URL"]);
  });

  it.each([
    ["a scheme", "http://llm.lan"],
    ["a port", "llm.lan:11434"],
    ["a path", "llm.lan/v1"],
    ["userinfo", "user@llm.lan"],
    ["userinfo with a password", "user:pw@llm.lan"],
    ["a wildcard", "*.lan"],
    ["a wildcard host", "*"],
    ["a comma", "llm.lan,other.lan"],
    ["a network range", "10.0.0.0/8"],
    ["a space", "llm.lan other.lan"],
    ["a trailing space", "llm.lan "],
    ["a percent escape", "llm%2elan"],
    ["a query", "llm.lan?x"],
    ["a fragment", "llm.lan#x"],
    ["a bracketed IPv6 literal with a port", "[::1]:11434"],
    ["an IPv6 literal with a zone", "fe80::1%eth0"],
    ["a malformed IPv6 literal", "[::1"],
    ["a name that looks like a port", "abc:80"],
  ])("refuses a value with %s, naming only AI_ALLOWED_PRIVATE_HOST", (_label, value) => {
    expect(keysOf({ ...LAN, AI_ALLOWED_PRIVATE_HOST: value })).toEqual(["AI_ALLOWED_PRIVATE_HOST"]);
  });

  it("refuses a host that differs from the host of AI_BASE_URL, so a changed URL never keeps an allowance meant for the old host", () => {
    const found = issues({ ...LAN, AI_ALLOWED_PRIVATE_HOST: "other.lan" });
    expect(found).toEqual([{ key: "AI_ALLOWED_PRIVATE_HOST", message: "must be the host of AI_BASE_URL" }]);
    expect(keysOf({ ...LAN, AI_BASE_URL: "http://other.lan:11434/v1", AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).toEqual(["AI_ALLOWED_PRIVATE_HOST"]);
  });

  it("does not fold a trailing dot: it is another host", () => {
    expect(keysOf({ ...LAN, AI_ALLOWED_PRIVATE_HOST: "llm.lan." })).toEqual(["AI_ALLOWED_PRIVATE_HOST"]);
    expect(keysOf({ ...LAN, AI_BASE_URL: "http://llm.lan.:11434/v1", AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).toEqual(["AI_ALLOWED_PRIVATE_HOST"]);
    expect(keysOf({ ...LAN, AI_BASE_URL: "http://llm.lan.:11434/v1", AI_ALLOWED_PRIVATE_HOST: "llm.lan." })).toEqual([]);
  });

  it.each([
    ["case", "http://llm.lan:11434/v1", "LLM.Lan"],
    ["case in the URL", "http://LLM.LAN/v1", "llm.lan"],
    ["the default port", "http://llm.lan:80/v1", "llm.lan"],
    ["an IPv4 notation", "http://0300.168.1.20:11434/v1", "192.168.1.20"],
    ["an IPv4 notation in the value", "http://192.168.1.20:11434/v1", "0xc0.0xa8.1.20"],
    ["a short IPv4 notation", "http://10.0.0.1:11434/v1", "10.1"],
    ["IDNA", "http://xn--bcher-kva.example/v1", "bücher.example"],
    ["IDNA in the URL", "http://bücher.example/v1", "xn--bcher-kva.example"],
    ["a compressed IPv6 literal", "http://[0:0:0:0:0:0:0:1]:11434/v1", "::1"],
    ["a bracketed IPv6 literal", "http://[::1]:11434/v1", "[::1]"],
    ["an expanded IPv6 literal in the value", "http://[::1]:11434/v1", "0:0:0:0:0:0:0:1"],
    ["a unique-local IPv6 literal", "http://[fd00::1]/v1", "FD00:0::1"],
  ])("matches after URL normalisation: %s", (_label, base, host) => {
    expect(issues({ ...AI, AI_BASE_URL: base, AI_ALLOWED_PRIVATE_HOST: host })).toEqual([]);
  });

  it("is not held by the worker", () => {
    expect(loadConfig("worker", productionEnv({ ...LAN, AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).config).not.toHaveProperty("AI_ALLOWED_PRIVATE_HOST");
  });
});
