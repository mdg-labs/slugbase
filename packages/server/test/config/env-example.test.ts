import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  OIDC_OPTIONAL_FIELDS,
  OIDC_REQUIRED_FIELDS,
  PROCESS_TYPES,
  declaredKeys,
  envSchemas,
  loadConfig,
} from "../../src/config/index.ts";
import {
  DEVELOPMENT_APP_ORIGIN,
  DEVELOPMENT_DATABASE_MIGRATE_URL,
  DEVELOPMENT_DATABASE_URL,
  DEVELOPMENT_ENCRYPTION_KEY,
  DEVELOPMENT_ENCRYPTION_KEY_ID,
  DEVELOPMENT_SESSION_SECRET,
} from "../../src/config/development-defaults.ts";
import { parseEnvFile } from "./support.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const exampleText = readFileSync(join(ROOT, ".env.example"), "utf8");
const example = parseEnvFile(exampleText);

describe(".env.example", () => {
  it("lists exactly the keys the schemas declare", () => {
    expect([...example.keys()].sort()).toEqual([...declaredKeys()]);
  });

  it("names the OIDC_<SLUG>_* keys of a provider, as names only", () => {
    for (const field of [...OIDC_REQUIRED_FIELDS, ...OIDC_OPTIONAL_FIELDS]) {
      expect(exampleText, field).toMatch(new RegExp(`^# +OIDC_<SLUG>_${field}\\b`, "m"));
    }
    expect([...example.keys()].filter((key) => key.startsWith("OIDC_"))).toEqual([]);
  });

  it("carries the development defaults the schema refuses in production", () => {
    const defaults = Object.assign({}, ...PROCESS_TYPES.map((type) => envSchemas[type].developmentDefaults)) as Record<string, string>;
    expect(defaults).toEqual({
      APP_ORIGIN: DEVELOPMENT_APP_ORIGIN,
      DATABASE_URL: DEVELOPMENT_DATABASE_URL,
      DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL,
      SESSION_SECRET: DEVELOPMENT_SESSION_SECRET,
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      ENCRYPTION_KEY_ID: DEVELOPMENT_ENCRYPTION_KEY_ID,
    });
    for (const [key, value] of Object.entries(defaults)) {
      expect(example.get(key), key).toBe(value);
    }
  });

  it.each(PROCESS_TYPES)("starts %s in development", (type) => {
    const env = Object.fromEntries(example);
    expect(loadConfig(type, env).warnings).toEqual([]);
  });

  it.each(PROCESS_TYPES)("is refused by %s in production", (type) => {
    const env = { ...Object.fromEntries(example), NODE_ENV: "production" };
    expect(() => loadConfig(type, env)).toThrow(ConfigError);
  });

  it("holds the schema defaults for the keys that have one", () => {
    const { config } = loadConfig("server", Object.fromEntries(example));
    expect(example.get("METRICS_PORT")).toBe("");
    expect(example.get("ERROR_REPORT_DSN")).toBe("");
    expect(config.ERROR_REPORT_DSN).toBeUndefined();
    expect(config.METRICS_PORT).toBeUndefined();
    expect(config).toMatchObject({
      PORT: Number(example.get("PORT")),
      TRUSTED_PROXY_HOPS: Number(example.get("TRUSTED_PROXY_HOPS")),
      API_DOCS_ENABLED: example.get("API_DOCS_ENABLED") === "true",
      DOCS_BASE_URL: example.get("DOCS_BASE_URL"),
      MIGRATE_ON_START: example.get("MIGRATE_ON_START") === "true",
      SETUP_ENABLED: example.get("SETUP_ENABLED") === "true",
      SETUP_TOKEN_REQUIRED: example.get("SETUP_TOKEN_REQUIRED") === "true",
      BREACHED_PASSWORD_CHECK: example.get("BREACHED_PASSWORD_CHECK") === "true",
      SLUGBASE_ALLOW_OWNER_CONNECTION: example.get("SLUGBASE_ALLOW_OWNER_CONNECTION") === "true",
      LOG_LEVEL: example.get("LOG_LEVEL"),
    });
  });
});

describe("pnpm dev:env", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function workdir(): string {
    const directory = mkdtempSync(join(tmpdir(), "slugbase-dev-env-"));
    directories.push(directory);
    cpSync(join(ROOT, ".env.example"), join(directory, ".env.example"));
    return directory;
  }

  function run(directory: string) {
    return spawnSync(process.execPath, [join(ROOT, "scripts/dev-env.mjs"), directory], { encoding: "utf8", timeout: 30_000 });
  }

  it("is the dev:env script of the workspace", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["dev:env"]).toBe("node scripts/dev-env.mjs");
  });

  it("writes .env with generated secrets that production accepts", () => {
    const directory = workdir();
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);

    const generated = parseEnvFile(readFileSync(join(directory, ".env"), "utf8"));
    expect([...generated.keys()].sort()).toEqual([...example.keys()].sort());
    expect(generated.get("SESSION_SECRET")).not.toBe(example.get("SESSION_SECRET"));
    expect(generated.get("ENCRYPTION_KEY")).not.toBe(example.get("ENCRYPTION_KEY"));
    for (const [key, value] of example) {
      if (key !== "SESSION_SECRET" && key !== "ENCRYPTION_KEY") {
        expect(generated.get(key), key).toBe(value);
      }
    }

    const env = Object.fromEntries(generated);
    expect(() => loadConfig("server", env)).not.toThrow();
    const production = {
      ...env,
      NODE_ENV: "production",
      APP_ORIGIN: "https://bookmarks.example.com",
      DATABASE_URL: "postgres://slugbase_app:prod-pw-x1@db.internal/slugbase",
      DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:prod-pw-x2@db.internal/slugbase",
      ENCRYPTION_KEY_ID: "k1",
    };
    expect(() => loadConfig("server", production)).not.toThrow();
  });

  it("does not print the generated values", () => {
    const directory = workdir();
    const result = run(directory);
    const generated = parseEnvFile(readFileSync(join(directory, ".env"), "utf8"));
    for (const key of ["SESSION_SECRET", "ENCRYPTION_KEY"]) {
      expect(result.stdout + result.stderr).not.toContain(generated.get(key) ?? "missing");
    }
  });

  it("generates a different secret each time", () => {
    const first = workdir();
    const second = workdir();
    run(first);
    run(second);
    expect(parseEnvFile(readFileSync(join(first, ".env"), "utf8")).get("SESSION_SECRET")).not.toBe(
      parseEnvFile(readFileSync(join(second, ".env"), "utf8")).get("SESSION_SECRET"),
    );
  });

  it("refuses to overwrite an existing .env", () => {
    const directory = workdir();
    writeFileSync(join(directory, ".env"), "KEEP=me\n");
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".env already exists");
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe("KEEP=me\n");
  });

  it("fails without writing when the template lacks a generated key", () => {
    const directory = workdir();
    writeFileSync(join(directory, ".env.example"), "NODE_ENV=development\n");
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(existsSync(join(directory, ".env"))).toBe(false);
  });
});
