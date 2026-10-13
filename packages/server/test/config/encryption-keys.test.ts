import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.ts";
import { productionEnv } from "./support.ts";

const OLD = randomBytes(32).toString("base64");
const OLDER = randomBytes(32).toString("base64url");

function issues(env: Record<string, string | undefined>, type: "server" | "worker" = "server"): string[] {
  try {
    loadConfig(type, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues.map((issue) => issue.key);
    }
    throw error;
  }
  return [];
}

describe("the secret-box keys", () => {
  it.each(["server", "worker"] as const)("%s: no previous key unless ENCRYPTION_KEY_PREVIOUS is set", (type) => {
    expect(loadConfig(type, productionEnv()).config.ENCRYPTION_KEY_PREVIOUS).toEqual([]);
    expect(loadConfig(type, productionEnv({ ENCRYPTION_KEY_PREVIOUS: "" })).config.ENCRYPTION_KEY_PREVIOUS).toEqual([]);
  });

  it.each(["server", "worker"] as const)("%s: reads id:key pairs in order", (type) => {
    const { config } = loadConfig(type, productionEnv({ ENCRYPTION_KEY_PREVIOUS: `k0:${OLD}, k-older:${OLDER}` }));
    expect(config.ENCRYPTION_KEY_PREVIOUS).toEqual([
      { keyId: "k0", key: OLD },
      { keyId: "k-older", key: OLDER },
    ]);
  });

  it.each([
    ["a key of 31 bytes", `k0:${Buffer.alloc(31, 3).toString("base64")}`],
    ["a key of 33 bytes", `k0:${Buffer.alloc(33, 3).toString("base64")}`],
    ["a key that is not base64", `k0:${"not base64 !!".padEnd(44, "?")}`],
    ["a pair with no id", `:${OLD}`],
    ["a pair with no separator", OLD],
    ["an id with a forbidden character", `k 0:${OLD}`],
    ["an id longer than 64 characters", `${"a".repeat(65)}:${OLD}`],
    ["an empty entry", `k0:${OLD},`],
    ["a repeated id", `k0:${OLD},k0:${OLDER}`],
    ["the id of the current key", `k1:${OLD}`],
  ])("refuses %s, naming only the key", (_name, value) => {
    expect(issues(productionEnv({ ENCRYPTION_KEY_PREVIOUS: value }))).toEqual(["ENCRYPTION_KEY_PREVIOUS"]);
    expect(issues(productionEnv({ ENCRYPTION_KEY_PREVIOUS: value }), "worker")).toEqual(["ENCRYPTION_KEY_PREVIOUS"]);
  });

  it("does not echo a refused previous key", () => {
    const key = Buffer.alloc(16, 5).toString("base64");
    try {
      loadConfig("server", productionEnv({ ENCRYPTION_KEY_PREVIOUS: `k0:${key}` }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const thrown = error as Error;
      expect([JSON.stringify(thrown), thrown.message, thrown.stack ?? ""].join("\n")).not.toContain(key);
    }
  });

  it("refuses a current key that does not decode to 32 bytes", () => {
    expect(issues(productionEnv({ ENCRYPTION_KEY: Buffer.alloc(31, 7).toString("base64") }))).toEqual(["ENCRYPTION_KEY"]);
  });
});
