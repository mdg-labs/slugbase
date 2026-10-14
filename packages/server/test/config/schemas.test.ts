import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigError,
  PROCESS_TYPES,
  composeEnvSchema,
  envFragment,
  loadConfig,
  requireAllOrNone,
  validateEnvironment,
} from "../../src/config/index.ts";
import { productionEnv } from "./support.ts";

const development = productionEnv({
  NODE_ENV: "development",
  APP_ORIGIN: "http://localhost:5173",
});

function failure(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("process schemas", () => {
  it("applies the defaults of doc 01 section 11 to the server", () => {
    const { config } = loadConfig("server", development);
    expect(config).toMatchObject({
      NODE_ENV: "development",
      APP_ORIGIN: "http://localhost:5173",
      PORT: 3000,
      LOG_LEVEL: "info",
      MIGRATE_ON_START: true,
      SLUGBASE_ALLOW_OWNER_CONNECTION: false,
      TRUSTED_PROXY_HOPS: 0,
      API_DOCS_ENABLED: true,
      DOCS_BASE_URL: "https://slugbase.app/docs",
      SETUP_ENABLED: true,
      SETUP_TOKEN_REQUIRED: true,
    });
  });

  it("parses explicit values", () => {
    const { config } = loadConfig("server", {
      ...development,
      PORT: "8080",
      LOG_LEVEL: "debug",
      MIGRATE_ON_START: "0",
      SLUGBASE_ALLOW_OWNER_CONNECTION: "true",
      TRUSTED_PROXY_HOPS: "2",
      API_DOCS_ENABLED: "false",
      SETUP_ENABLED: "0",
      SETUP_TOKEN_REQUIRED: "false",
    });
    expect(config).toMatchObject({
      SETUP_ENABLED: false,
      SETUP_TOKEN_REQUIRED: false,
      PORT: 8080,
      LOG_LEVEL: "debug",
      MIGRATE_ON_START: false,
      SLUGBASE_ALLOW_OWNER_CONNECTION: true,
      TRUSTED_PROXY_HOPS: 2,
      API_DOCS_ENABLED: false,
    });
  });

  it("has no metrics listener unless METRICS_PORT is set, on the server and on the worker", () => {
    for (const type of ["server", "worker"] as const) {
      expect(loadConfig(type, development).config.METRICS_PORT).toBeUndefined();
      expect(loadConfig(type, { ...development, METRICS_PORT: "" }).config.METRICS_PORT).toBeUndefined();
      expect(loadConfig(type, { ...development, METRICS_PORT: "9464" }).config.METRICS_PORT).toBe(9464);
    }
    expect(Object.keys(loadConfig("migrate", { NODE_ENV: "production", DATABASE_MIGRATE_URL: productionEnv().DATABASE_MIGRATE_URL }).config)).not.toContain(
      "METRICS_PORT",
    );
  });

  it.each(["0", "65536", "9464.5", "-1", "metrics"])("names METRICS_PORT for the malformed value %j", (value) => {
    for (const type of ["server", "worker"] as const) {
      expect(failure(() => loadConfig(type, { ...development, METRICS_PORT: value })).issues.map((issue) => issue.key)).toEqual(["METRICS_PORT"]);
    }
  });

  it("selects no error reporting unless ERROR_REPORT_DSN is set, on the server and on the worker", () => {
    const dsn = "https://seedpublickey@errors.example.com/7";
    for (const type of ["server", "worker"] as const) {
      expect(loadConfig(type, development).config.ERROR_REPORT_DSN).toBeUndefined();
      expect(loadConfig(type, { ...development, ERROR_REPORT_DSN: "" }).config.ERROR_REPORT_DSN).toBeUndefined();
      expect(loadConfig(type, { ...development, ERROR_REPORT_DSN: dsn }).config.ERROR_REPORT_DSN).toBe(dsn);
      expect(loadConfig(type, { ...productionEnv(), ERROR_REPORT_DSN: dsn }).config.ERROR_REPORT_DSN).toBe(dsn);
    }
    expect(Object.keys(loadConfig("migrate", { NODE_ENV: "production", DATABASE_MIGRATE_URL: productionEnv().DATABASE_MIGRATE_URL }).config)).not.toContain(
      "ERROR_REPORT_DSN",
    );
  });

  it.each([
    "errors.example.com/1",
    "ftp://key@errors.example.com/1",
    "https://errors.example.com/1",
    "https://key@errors.example.com/project",
    "https://key@errors.example.com/",
    "https://key@errors.example.com/1?x=1",
  ])("names ERROR_REPORT_DSN for the malformed value %j", (value) => {
    for (const type of ["server", "worker"] as const) {
      expect(failure(() => loadConfig(type, { ...development, ERROR_REPORT_DSN: value })).issues.map((issue) => issue.key)).toEqual(["ERROR_REPORT_DSN"]);
    }
  });

  it("normalises APP_ORIGIN to an origin", () => {
    expect(loadConfig("server", { ...development, APP_ORIGIN: "https://Bookmarks.Example.com:443/" }).config.APP_ORIGIN).toBe(
      "https://bookmarks.example.com",
    );
  });

  it("gives the worker no listener and no migrator URL", () => {
    const { config } = loadConfig("worker", development);
    expect(Object.keys(config)).not.toContain("PORT");
    expect(Object.keys(config)).not.toContain("DATABASE_MIGRATE_URL");
    expect(Object.keys(config)).not.toContain("MIGRATE_ON_START");
  });

  it("needs only the migrator URL to migrate", () => {
    const { config } = loadConfig("migrate", {
      NODE_ENV: "production",
      DATABASE_MIGRATE_URL: productionEnv().DATABASE_MIGRATE_URL,
    });
    expect(Object.keys(config).sort()).toEqual(["DATABASE_MIGRATE_URL", "LOG_LEVEL", "NODE_ENV"]);
  });

  it("requires the migrator URL while the server migrates itself, and not otherwise", () => {
    const withoutUrl = { ...development, DATABASE_MIGRATE_URL: undefined };
    expect(failure(() => loadConfig("server", withoutUrl)).issues.map((issue) => issue.key)).toEqual(["DATABASE_MIGRATE_URL"]);
    expect(loadConfig("server", { ...withoutUrl, MIGRATE_ON_START: "false" }).config.DATABASE_MIGRATE_URL).toBeUndefined();
    expect(loadConfig("server", { ...withoutUrl, DATABASE_MIGRATE_URL: "", MIGRATE_ON_START: "false" }).config.DATABASE_MIGRATE_URL).toBeUndefined();
  });

  it.each(PROCESS_TYPES)("requires NODE_ENV for %s", (type) => {
    expect(failure(() => loadConfig(type, { ...development, NODE_ENV: undefined })).issues.map((issue) => issue.key)).toEqual(["NODE_ENV"]);
  });

  it.each([
    ["DOCS_BASE_URL", "ftp://docs.example.com"],
    ["DOCS_BASE_URL", "/docs"],
    ["DOCS_BASE_URL", "docs.example.com/docs"],
    ["DOCS_BASE_URL", "javascript:alert(1)"],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "80.5"],
    ["TRUSTED_PROXY_HOPS", "-1"],
    ["LOG_LEVEL", "verbose"],
    ["APP_ORIGIN", "https://bookmarks.example.com/app"],
    ["APP_ORIGIN", "bookmarks.example.com"],
    ["DATABASE_URL", "mysql://slugbase@localhost/slugbase"],
    ["API_DOCS_ENABLED", "yes"],
    ["SETUP_ENABLED", "yes"],
    ["SETUP_TOKEN_REQUIRED", ""],
  ])("names %s for the malformed value %j", (key, value) => {
    expect(failure(() => loadConfig("server", { ...development, [key]: value })).issues.map((issue) => issue.key)).toContain(key);
  });

  it("removes a trailing slash from DOCS_BASE_URL so links join it without doubling", () => {
    const docsBase = (value: string) => loadConfig("server", { ...development, DOCS_BASE_URL: value }).config.DOCS_BASE_URL;
    expect(docsBase("https://docs.example.com/docs/")).toBe("https://docs.example.com/docs");
    expect(docsBase("http://localhost:4321/")).toBe("http://localhost:4321");
    expect(docsBase("https://docs.example.com/docs")).toBe("https://docs.example.com/docs");
  });

  it("reports every bad key at once", () => {
    const keys = failure(() => loadConfig("server", { ...development, PORT: "x", LOG_LEVEL: "x", SESSION_SECRET: undefined })).issues.map(
      (issue) => issue.key,
    );
    expect(keys.sort()).toEqual(["LOG_LEVEL", "PORT", "SESSION_SECRET"]);
  });
});

describe("TRUSTED_PROXY_HOPS warning", () => {
  function hopsWarnings(type: "server" | "worker", env: Record<string, string | undefined>): string[] {
    return loadConfig(type, env).warnings.filter((warning) => warning.includes("TRUSTED_PROXY_HOPS"));
  }

  it("warns in production when it is unset, naming the key and no value", () => {
    const warnings = hopsWarnings("server", productionEnv());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^TRUSTED_PROXY_HOPS /);
    expect(warnings[0]).toContain("per-IP rate limits");
  });

  it("warns in production when it is set to 0, as .env.example sets it", () => {
    expect(hopsWarnings("server", productionEnv({ TRUSTED_PROXY_HOPS: "0" }))).toHaveLength(1);
  });

  it("does not warn in production once a proxy is trusted", () => {
    expect(hopsWarnings("server", productionEnv({ TRUSTED_PROXY_HOPS: "1" }))).toEqual([]);
  });

  it("does not warn outside production", () => {
    expect(hopsWarnings("server", development)).toEqual([]);
  });

  it("does not warn the worker, which has no public listener", () => {
    expect(hopsWarnings("worker", productionEnv())).toEqual([]);
  });

  it("is a warning, not a refusal: the configuration loads", () => {
    expect(loadConfig("server", productionEnv()).config.TRUSTED_PROXY_HOPS).toBe(0);
  });
});

describe("unknown SLUGBASE_* keys", () => {
  it("warns once, listing key names only", () => {
    const { warnings } = loadConfig("server", {
      ...development,
      SLUGBASE_TYPO_ONE: "value-one-zz9",
      SLUGBASE_TYPO_TWO: "value-two-zz9",
      OTHER_KEY: "x",
    });
    expect(warnings).toEqual(["Unknown SLUGBASE_* environment keys are ignored: SLUGBASE_TYPO_ONE, SLUGBASE_TYPO_TWO"]);
    expect(warnings.join("\n")).not.toContain("zz9");
  });

  it("knows the declared SLUGBASE_ key in every process type", () => {
    expect(loadConfig("worker", { ...development, SLUGBASE_ALLOW_OWNER_CONNECTION: "true" }).warnings).toEqual([]);
    expect(loadConfig("server", development).warnings).toEqual([]);
  });
});

describe("composition", () => {
  const smtp = envFragment({
    shape: {
      SMTP_HOST: z.string().optional(),
      SMTP_PORT: z.string().optional(),
    },
    refine(values, context) {
      requireAllOrNone(["SMTP_HOST", "SMTP_PORT"], values, context);
    },
  });
  const schema = composeEnvSchema([smtp]);

  it("accepts an unset and a complete key set of a configured adapter", () => {
    expect(validateEnvironment(schema, {}).config).toEqual({});
    expect(validateEnvironment(schema, { SMTP_HOST: "mail.example.com", SMTP_PORT: "587" }).config).toEqual({
      SMTP_HOST: "mail.example.com",
      SMTP_PORT: "587",
    });
  });

  it("refuses a partial set, naming the missing key", () => {
    const error = failure(() => validateEnvironment(schema, { SMTP_HOST: "mail.example.com" }));
    expect(error.issues.map((issue) => issue.key)).toEqual(["SMTP_PORT"]);
    expect(error.message).not.toContain("mail.example.com");
  });

  it("refuses a partial set in a composed process schema", () => {
    const server = composeEnvSchema([smtp]);
    expect(failure(() => validateEnvironment(server, { SMTP_PORT: "587" })).issues.map((issue) => issue.key)).toEqual(["SMTP_HOST"]);
  });

  it("does not warn about the keys of an extension module", () => {
    const { warnings } = validateEnvironment(schema, { SLUGBASE_CLOUD_THING: "x" }, { extraKeys: ["SLUGBASE_CLOUD_THING"] });
    expect(warnings).toEqual([]);
  });

  it("refuses two fragments that declare one key", () => {
    expect(() => composeEnvSchema([smtp, smtp])).toThrow(/SMTP_HOST/);
  });
});
