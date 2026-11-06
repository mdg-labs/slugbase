import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ProcessType } from "../../src/config/index.ts";
import { decodeBase64Key } from "../../src/config/fields.ts";
import {
  DEVELOPMENT_APP_ORIGIN,
  DEVELOPMENT_DATABASE_MIGRATE_URL,
  DEVELOPMENT_DATABASE_URL,
  DEVELOPMENT_ENCRYPTION_KEY,
  DEVELOPMENT_ENCRYPTION_KEY_ID,
  DEVELOPMENT_SESSION_SECRET,
} from "../../src/config/development-defaults.ts";
import { productionEnv } from "./support.ts";

function refusedKeys(type: ProcessType, env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(type, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...new Set(error.issues.map((issue) => issue.key))].sort();
    }
    throw error;
  }
  return [];
}

describe("production refusals (doc 01 section 11)", () => {
  it.each(["server", "worker", "migrate"] as const)("starts %s with a sound production environment", (type) => {
    expect(refusedKeys(type, productionEnv())).toEqual([]);
  });

  it.each([
    ["SESSION_SECRET is missing", { SESSION_SECRET: undefined }, "SESSION_SECRET"],
    ["SESSION_SECRET is empty", { SESSION_SECRET: "" }, "SESSION_SECRET"],
    ["SESSION_SECRET is short", { SESSION_SECRET: "a".repeat(31) }, "SESSION_SECRET"],
    ["ENCRYPTION_KEY is missing", { ENCRYPTION_KEY: undefined }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY decodes to 31 bytes", { ENCRYPTION_KEY: Buffer.alloc(31, 7).toString("base64") }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY decodes to 33 bytes", { ENCRYPTION_KEY: Buffer.alloc(33, 7).toString("base64") }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY is not base64", { ENCRYPTION_KEY: "not base64 !!".padEnd(44, "?") }, "ENCRYPTION_KEY"],
    ["APP_ORIGIN is http", { APP_ORIGIN: "http://bookmarks.example.com" }, "APP_ORIGIN"],
    ["APP_ORIGIN is missing", { APP_ORIGIN: undefined }, "APP_ORIGIN"],
    ["APP_ORIGIN is the development default", { APP_ORIGIN: DEVELOPMENT_APP_ORIGIN }, "APP_ORIGIN"],
    ["SESSION_SECRET is the development default", { SESSION_SECRET: DEVELOPMENT_SESSION_SECRET }, "SESSION_SECRET"],
    ["ENCRYPTION_KEY is the development default", { ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY_ID is the development default", { ENCRYPTION_KEY_ID: DEVELOPMENT_ENCRYPTION_KEY_ID }, "ENCRYPTION_KEY_ID"],
    ["DATABASE_URL is the development default", { DATABASE_URL: DEVELOPMENT_DATABASE_URL }, "DATABASE_URL"],
    [
      "DATABASE_URL keeps the development password on another host",
      { DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@db.internal:5432/slugbase" },
      "DATABASE_URL",
    ],
    ["DATABASE_MIGRATE_URL is the development default", { DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL }, "DATABASE_MIGRATE_URL"],
  ])("refuses to start the server when %s", (_name, overrides, key) => {
    expect(refusedKeys("server", productionEnv(overrides))).toContain(key);
  });

  describe("the development encryption key in another encoding", () => {
    const bytes = Buffer.from(DEVELOPMENT_ENCRYPTION_KEY, "base64");
    // The same 32 bytes as the published key, spelled every way the key parser accepts.
    const spellings: readonly (readonly [string, string])[] = [
      ["without its padding", bytes.toString("base64").replace(/=+$/, "")],
      ["with double padding", `${bytes.toString("base64").replace(/=+$/, "")}==`],
      ["in the url-safe alphabet", bytes.toString("base64url")],
      ["in the url-safe alphabet with padding", bytes.toString("base64url").padEnd(44, "=")],
    ];

    it("spells the same key bytes as the published value", () => {
      for (const [, spelling] of spellings) {
        expect(Buffer.from(spelling, "base64").equals(bytes)).toBe(true);
      }
    });

    it.each(spellings)("refuses ENCRYPTION_KEY %s in production", (_name, spelling) => {
      expect(() => loadConfig("server", productionEnv({ ENCRYPTION_KEY: spelling }))).toThrow(ConfigError);
      expect(refusedKeys("server", productionEnv({ ENCRYPTION_KEY: spelling }))).toEqual(["ENCRYPTION_KEY"]);
      expect(refusedKeys("worker", productionEnv({ ENCRYPTION_KEY: spelling }))).toEqual(["ENCRYPTION_KEY"]);
    });

    const previousSpellings: readonly (readonly [string, string])[] = [
      ["the published spelling", DEVELOPMENT_ENCRYPTION_KEY],
      ...spellings,
    ];

    it.each(previousSpellings)("refuses an ENCRYPTION_KEY_PREVIOUS entry holding the key %s in production", (_name, spelling) => {
      const previous = `old-1:${randomBytes(32).toString("base64")},old-2:${spelling}`;
      expect(refusedKeys("server", productionEnv({ ENCRYPTION_KEY_PREVIOUS: previous }))).toEqual(["ENCRYPTION_KEY_PREVIOUS"]);
    });

    it("names the key and never the value", () => {
      const spelling = bytes.toString("base64").replace(/=+$/, "");
      try {
        loadConfig("server", productionEnv({ ENCRYPTION_KEY: spelling }));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain("ENCRYPTION_KEY");
        expect((error as ConfigError).message).not.toContain(spelling);
      }
    });

    it("reports the published spelling once", () => {
      try {
        loadConfig("server", productionEnv({ ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY }));
        expect.unreachable();
      } catch (error) {
        expect((error as ConfigError).issues.filter((issue) => issue.key === "ENCRYPTION_KEY")).toHaveLength(1);
      }
    });

    describe("a key whose standard spelling holds both + and /", () => {
      // 0xfb bytes spell as "+/v7" groups, so the url-safe spelling ("-_v7") differs from the standard one in both characters.
      const key = Buffer.alloc(32, 251);
      const standard = key.toString("base64");
      const alphabet: readonly (readonly [string, string])[] = [
        ["standard", standard],
        ["standard without padding", standard.replace(/=+$/, "")],
        ["url-safe", key.toString("base64url")],
        ["url-safe with padding", key.toString("base64url").padEnd(44, "=")],
      ];

      it("is a key the standard alphabet spells with both characters", () => {
        expect(standard).toContain("+");
        expect(standard).toContain("/");
        expect(key.toString("base64url")).toContain("-");
        expect(key.toString("base64url")).toContain("_");
      });

      it.each(alphabet)("decodes the %s spelling to the key bytes", (_name, spelling) => {
        expect(decodeBase64Key(spelling, 32)?.equals(key)).toBe(true);
      });

      it.each(alphabet)("accepts the %s spelling as ENCRYPTION_KEY and as a previous key in production", (_name, spelling) => {
        expect(refusedKeys("server", productionEnv({ ENCRYPTION_KEY: spelling }))).toEqual([]);
        expect(refusedKeys("server", productionEnv({ ENCRYPTION_KEY_PREVIOUS: `old-1:${spelling}` }))).toEqual([]);
      });
    });

    it("accepts other keys, current and previous, in production", () => {
      const other = randomBytes(32);
      expect(
        refusedKeys(
          "server",
          productionEnv({
            ENCRYPTION_KEY: other.toString("base64url"),
            ENCRYPTION_KEY_PREVIOUS: `old-1:${randomBytes(32).toString("base64")},old-2:${randomBytes(32).toString("base64url")}`,
          }),
        ),
      ).toEqual([]);
    });

    it("accepts the key in every spelling outside production", () => {
      for (const [, spelling] of spellings) {
        expect(
          refusedKeys(
            "server",
            productionEnv({
              NODE_ENV: "development",
              ENCRYPTION_KEY: spelling,
              ENCRYPTION_KEY_PREVIOUS: `old-1:${spelling}`,
            }),
          ),
        ).toEqual([]);
      }
    });
  });

  it("refuses the worker and migrate for their own keys", () => {
    expect(refusedKeys("worker", productionEnv({ SESSION_SECRET: "short" }))).toEqual(["SESSION_SECRET"]);
    expect(refusedKeys("migrate", productionEnv({ DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL }))).toEqual([
      "DATABASE_MIGRATE_URL",
    ]);
  });

  it("accepts a development default outside production", () => {
    const development = productionEnv({
      NODE_ENV: "development",
      APP_ORIGIN: DEVELOPMENT_APP_ORIGIN,
      SESSION_SECRET: DEVELOPMENT_SESSION_SECRET,
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      ENCRYPTION_KEY_ID: DEVELOPMENT_ENCRYPTION_KEY_ID,
      DATABASE_URL: DEVELOPMENT_DATABASE_URL,
      DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL,
    });
    expect(refusedKeys("server", development)).toEqual([]);
  });

  it("accepts a short session secret outside production, and still requires the encryption key to decode", () => {
    expect(refusedKeys("server", productionEnv({ NODE_ENV: "test", APP_ORIGIN: "http://localhost:5173", SESSION_SECRET: "x" }))).toEqual([]);
    expect(refusedKeys("server", productionEnv({ NODE_ENV: "test", ENCRYPTION_KEY: "x" }))).toEqual(["ENCRYPTION_KEY"]);
  });
});
